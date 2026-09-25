'use strict';

const { randomBytes } = require('node:crypto');

const { UnavailableError } = require('./decisions');
const {
	ENDPOINTS,
	normalizeRegion,
	orderedCandidates,
} = require('./endpoints');
const {
	asSeconds,
	getSettings,
	isOn,
	parseObject,
	patchSettings,
} = require('./settings');

const PLUGIN_VERSION = require('../package.json').version;
const SUPPORT_URL = 'https://forumfortress.com/#contact';
const CHECK_TOTAL_BUDGET_MS = 5000;
const CHECK_ENDPOINT_TIMEOUT_MS = 1000;
const BOOTSTRAP_TOTAL_BUDGET_MS = 3000;
const BOOTSTRAP_ENDPOINT_TIMEOUT_MS = 1000;
const BOOTSTRAP_RETRY_BACKOFF_SECONDS = 300;
const BOOTSTRAP_LOCK_TTL_SECONDS = 15;
const BOOTSTRAP_LOCK_WAIT_MS = 4500;
const BOOTSTRAP_LOCK_RETRY_MS = 75;
const BOOTSTRAP_PATHS = Object.freeze([
	'/v1/site/bootstrap',
	'/v1/site/nodebb/bootstrap',
]);
const STANDARD_HEARTBEAT_SECONDS = 3600;
const PRO_HEARTBEAT_SECONDS = 600;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function tryRequire(path) {
	try {
		return require.main && require.main.require(path);
	} catch (error) {
		return null;
	}
}

function defaultSettingsStore() {
	return tryRequire('./src/meta')?.settings;
}

function defaultDatabase() {
	return tryRequire('./src/database');
}

function defaultLogger() {
	return tryRequire('./src/logger') || console;
}

function nowSeconds(clock) {
	return Math.floor(clock() / 1000);
}

function sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
	return typeof value === 'string' && Boolean(value.trim());
}

function isFiniteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function redact(value, apiKey = '') {
	let output = String(value || '');
	if (apiKey) {
		output = output.split(apiKey).join('[redacted]');
	}
	return output
		.replace(/("?(?:api_key|bootstrap_recovery_token)"?\s*[:=]\s*"?)[^",\s}]+/giu, '$1[redacted]')
		.replace(/([?&](?:api_key|token)=)[^&\s]+/giu, '$1[redacted]')
		.replace(/(Bearer\s+)[^\s,;]+/giu, '$1[redacted]')
		.replace(/(X-FF-Key\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]');
}

function safeAdminData(value) {
	if (Array.isArray(value)) {
		return value.map(safeAdminData);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => !['api_key', 'apiKey', 'bootstrap_recovery_token'].includes(key))
		.map(([key, item]) => [key, safeAdminData(item)]));
}

class EndpointRequestError extends Error {
	constructor(message, { statusCode = 0, retryable = true, errorCode = null, cause } = {}) {
		super(message, { cause });
		this.name = 'EndpointRequestError';
		this.statusCode = statusCode;
		this.retryable = retryable;
		this.errorCode = errorCode;
	}
}

class ForumFortressClient {
	constructor(options = {}) {
		this.settingsStore = options.settingsStore || defaultSettingsStore();
		this.database = options.database || defaultDatabase();
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.logger = options.logger || defaultLogger();
		const nconf = options.nconf || tryRequire('nconf');
		this.nodeVersion = options.nodeVersion
			|| nconf?.get('version')
			|| tryRequire('./package.json')?.version
			|| 'unknown';
		this.forumUrl = options.forumUrl
			|| nconf?.get('url')
			|| tryRequire('./src/meta')?.config?.url
			|| '';
		this.clock = options.clock || Date.now;
		this.bootstrapInFlight = null;
		this.bootstrapLockWaitMs = Number.isFinite(options.bootstrapLockWaitMs)
			? Math.max(0, options.bootstrapLockWaitMs)
			: BOOTSTRAP_LOCK_WAIT_MS;
		this.bootstrapLockRetryMs = Number.isFinite(options.bootstrapLockRetryMs)
			? Math.max(1, options.bootstrapLockRetryMs)
			: BOOTSTRAP_LOCK_RETRY_MS;
	}

	async settings() {
		if (!this.settingsStore) {
			throw new Error('Forum Fortress could not access NodeBB plugin settings.');
		}
		return getSettings(this.settingsStore);
	}

	async updateSettings(values) {
		return patchSettings(this.settingsStore, values);
	}

	async isEnabled() {
		const settings = await this.settings();
		return isOn(settings.enabled) && !isOn(settings.bootstrap_suppressed);
	}

	async check(eventType, payload = {}) {
		if (!await this.isEnabled()) {
			return null;
		}

		try {
			await this.bootstrapIfNeeded();
			const result = await this.requestChecks(`/v1/check/${eventType}`, {
				...(await this.commonPayload()),
				...payload,
			});
			const decision = String(result.decision || '').trim().toLowerCase();
			if (!['allow', 'review', 'block'].includes(decision)) {
				throw new UnavailableError('[[forum-fortress:unavailable]]');
			}
			await this.persistIdentity(result);
			return result;
		} catch (error) {
			this.logFailure(`check/${eventType}`, error);
			if (isOn((await this.settings()).fail_open)) {
				return null;
			}
			throw new UnavailableError('[[forum-fortress:unavailable]]', error);
		}
	}

	async bootstrapIfNeeded(force = false) {
		const settings = await this.settings();
		if (!force && isOn(settings.bootstrap_suppressed)) {
			throw new UnavailableError('[[forum-fortress:disconnected]]');
		}
		const state = parseObject(settings.endpoint_state);
		const now = nowSeconds(this.clock);
		if (!force && settings.api_key && (!state.rebootstrap_at || now < Number(state.rebootstrap_at))) {
			return null;
		}
		if (!force && Number(state.last_bootstrap_failure_at || 0) > now - BOOTSTRAP_RETRY_BACKOFF_SECONDS) {
			throw new UnavailableError('[[forum-fortress:bootstrap-wait]]');
		}
		if (this.bootstrapInFlight) {
			return this.bootstrapInFlight;
		}

		this.bootstrapInFlight = this.withBootstrapLock(
			() => this.performBootstrap(force),
			{ apiKey: settings.api_key, lastBootstrapAt: settings.last_bootstrap_at }
		).finally(() => {
			this.bootstrapInFlight = null;
		});
		return this.bootstrapInFlight;
	}

	async withBootstrapLock(callback, initialIdentity = {}) {
		const lock = await this.tryAcquireBootstrapLock();
		if (!lock.contended) {
			try {
				return await callback();
			} finally {
				await lock.release();
			}
		}

		const deadline = Date.now() + this.bootstrapLockWaitMs;
		while (Date.now() < deadline) {
			await sleep(this.bootstrapLockRetryMs);
			const settings = await this.settings();
			if (settings.api_key && (!initialIdentity.apiKey
				|| settings.api_key !== initialIdentity.apiKey
				|| settings.last_bootstrap_at !== initialIdentity.lastBootstrapAt)) {
				return null;
			}
		}
		throw new UnavailableError('[[forum-fortress:bootstrap-wait]]');
	}

	async tryAcquireBootstrapLock() {
		const database = this.database;
		if (!database || typeof database.increment !== 'function' || typeof database.expire !== 'function' || typeof database.delete !== 'function') {
			return { contended: false, release: async () => {} };
		}

		const domain = this.domain() || 'unknown';
		const key = `forum-fortress:bootstrap:${domain}`;
		try {
			const attempts = Number(await database.increment(key));
			if (attempts !== 1) {
				return { contended: true, release: async () => {} };
			}
			await database.expire(key, BOOTSTRAP_LOCK_TTL_SECONDS);
			return {
				contended: false,
				release: async () => { await database.delete(key); },
			};
		} catch (error) {
			// Bootstrap remains available on database adapters that cannot provide
			// the portable increment/expiry lease primitives.
			return { contended: false, release: async () => {} };
		}
	}

	async performBootstrap(force) {
		let settings = await this.settings();
		const payload = await this.commonPayload();
		if (force && String(settings.api_key || '').startsWith('ff_ob_')) {
			delete payload.api_key;
		}
		if (!payload.api_key) {
			payload.bootstrap_recovery_token = await this.bootstrapRecoveryToken();
		}

		const state = parseObject(settings.endpoint_state);
		state.last_bootstrap_attempt_at = nowSeconds(this.clock);
		await this.updateSettings({ endpoint_state: JSON.stringify(state) });

		const started = this.clock();
		let lastError = null;
		for (const base of await this.checkCandidates()) {
			for (const path of BOOTSTRAP_PATHS) {
				const remaining = BOOTSTRAP_TOTAL_BUDGET_MS - (this.clock() - started);
				if (remaining <= 0) {
					break;
				}
				try {
					const requestPayload = path === '/v1/site/bootstrap'
						? { ...payload, bootstrap_recovery_token: undefined }
						: payload;
					const result = await this.request('POST', `${base}${path}`, requestPayload, Math.min(BOOTSTRAP_ENDPOINT_TIMEOUT_MS, remaining));
					if (!String(result.api_key || '').trim()) {
						throw new EndpointRequestError('Forum Fortress did not return an API key during NodeBB bootstrap.', { retryable: false });
					}
					await this.persistIdentity(result, base);
					settings = await this.settings();
					const successState = parseObject(settings.endpoint_state);
					delete successState.last_bootstrap_failure_at;
					await this.updateSettings({
						endpoint_state: JSON.stringify(successState),
						last_bootstrap_error: '',
						last_bootstrap_at: String(nowSeconds(this.clock)),
					});
					return result;
				} catch (error) {
					lastError = lastError instanceof EndpointRequestError && !(error instanceof EndpointRequestError)
						? lastError
						: error;
					await this.recordEndpointResult(base, false, path, error);
					const isDedicatedRouteNotFound = path === BOOTSTRAP_PATHS[0]
						&& error instanceof EndpointRequestError
						&& error.statusCode === 404
						&& error.errorCode === 'not_found';
					if (!isDedicatedRouteNotFound) {
						break;
					}
				}
			}
			if (this.clock() - started >= BOOTSTRAP_TOTAL_BUDGET_MS) {
				break;
			}
		}

		settings = await this.settings();
		const failureState = parseObject(settings.endpoint_state);
		failureState.last_bootstrap_failure_at = nowSeconds(this.clock);
		await this.updateSettings({
			endpoint_state: JSON.stringify(failureState),
			last_bootstrap_error: redact(lastError?.message || 'No Forum Fortress bootstrap endpoint is available.', settings.api_key).slice(0, 500),
			last_bootstrap_at: String(nowSeconds(this.clock)),
		});
		throw lastError || new EndpointRequestError('No Forum Fortress bootstrap endpoint is available.');
	}

	async siteStatus(timeoutOverride) {
		const result = this.validateSiteStatus(await this.requestWithIdentityRecovery('GET', '/v1/site/status', async () => {
			const settings = await this.settings();
			return { api_key: settings.api_key, domain: this.domain() };
		}, false, timeoutOverride, true, false));
		await this.persistObservedStatus(result);
		return result;
	}

	async forumStats() {
		return this.validateForumStats(await this.requestWithIdentityRecovery('GET', '/v1/forum/stats', async () => {
			const settings = await this.settings();
			return { api_key: settings.api_key, domain: this.domain() };
		}, false, undefined, true, false));
	}

	async capabilities() {
		return this.requestAcrossCandidates('GET', '/v1/capabilities', {}, await this.checkCandidates());
	}

	async registerSite(email = '') {
		const result = await this.requestWithIdentityRecovery('POST', '/v1/site/register', async () => ({
			...(await this.commonPayload()),
			email: String(email || '').trim(),
		}), false, undefined, true, false);
		await this.persistIdentity(result, '', { activate: true });
		return result;
	}

	async setAttackMode(enabled) {
		const path = enabled ? '/v1/site/attack-mode' : '/v1/site/attack-mode/end';
		const result = await this.requestWithIdentityRecovery('POST', path, () => this.commonPayload(), false, undefined, false, true);
		const active = result.attack_mode_active ?? result.enabled ?? result.attack_mode?.enabled;
		if (typeof active !== 'boolean' || active !== Boolean(enabled)) {
			throw new UnavailableError(enabled
				? '[[forum-fortress:attack-start-unconfirmed]]'
				: '[[forum-fortress:attack-end-unconfirmed]]');
		}
		return { ...safeAdminData(result), attack_mode_active: Boolean(active) };
	}

	async portalLaunch() {
		return this.requestWithIdentityRecovery('POST', '/v1/site/portal', () => this.commonPayload(), false, undefined, false, true);
	}

	async confirmConnection(timeoutOverride, forceBootstrap = false) {
		let settings = await this.settings();
		if (settings.api_key && !settings.site_id) {
			await this.siteStatus(timeoutOverride);
			settings = await this.settings();
		}
		const result = this.validatePing(await this.requestWithIdentityRecovery('POST', '/v1/site/ping', () => this.commonPayload(), forceBootstrap, timeoutOverride, true, false));
		await this.persistObservedStatus(result);
		const state = parseObject((await this.settings()).endpoint_state);
		state.last_site_ping_at = nowSeconds(this.clock);
		delete state.last_heartbeat_error;
		await this.updateSettings({ endpoint_state: JSON.stringify(state) });
		return result;
	}

	async sync(force = false) {
		if (!await this.isEnabled()) {
			return { enabled: false };
		}
		if (!force) {
			await this.bootstrapIfNeeded();
			if (!await this.heartbeatIsDue()) {
				return { enabled: true, heartbeat: 'not_due', endpoint_state: await this.endpointStateSummary() };
			}
		}

		const state = parseObject((await this.settings()).endpoint_state);
		state.heartbeat_last_attempt_at = nowSeconds(this.clock);
		await this.updateSettings({ endpoint_state: JSON.stringify(state) });
		const ping = await this.confirmConnection();
		return { enabled: true, heartbeat: 'sent', ping: safeAdminData(ping), endpoint_state: await this.endpointStateSummary() };
	}

	async deprovisionSite(reason = 'manual_disconnect') {
		let settings = await this.settings();
		if (!settings.api_key || !settings.site_id) {
			if (settings.bootstrap_recovery_token) {
				await this.bootstrapIfNeeded(true);
				settings = await this.settings();
			}
			if (!settings.api_key || !settings.site_id) {
				await this.clearIdentity();
				await this.updateSettings({ bootstrap_suppressed: 'on', enabled: 'off' });
				return { status: 'no_identity' };
			}
		}

		try {
			const requestDeprovision = async () => this.requestAcrossCandidates(
				'POST',
				'/v1/site/deprovision',
				{ ...(await this.commonPayload()), reason },
				await this.controlCandidates(),
				3,
				true
			);
			let result;
			try {
				result = await requestDeprovision();
			} catch (error) {
				if (this.isAlreadyRemovedError(error)) {
					await this.clearIdentity();
					await this.updateSettings({ bootstrap_suppressed: 'on', enabled: 'off' });
					return { status: 'already_removed' };
				}
				if (!this.isStaleIdentityError(error)) {
					throw error;
				}
				await this.recoverIdentityOrRestore(error);
				try {
					result = await requestDeprovision();
				} catch (retryError) {
					if (this.isAlreadyRemovedError(retryError)) {
						await this.clearIdentity();
						await this.updateSettings({ bootstrap_suppressed: 'on', enabled: 'off' });
						return { status: 'already_removed' };
					}
					throw retryError;
				}
			}
			const status = String(result.status || '').trim().toLowerCase();
			if (!['ok', 'already_removed', 'no_identity'].includes(status)) {
				throw new UnavailableError('[[forum-fortress:deprovision-unconfirmed]]');
			}
			await this.clearIdentity();
			await this.updateSettings({ bootstrap_suppressed: 'on', enabled: 'off' });
			return safeAdminData(result);
		} catch (error) {
			await this.updateSettings({
				last_bootstrap_error: redact(error.message, settings.api_key).slice(0, 500),
			});
			throw error;
		}
	}

	async dashboard() {
		if (!await this.isEnabled()) {
			return {
				disabled: true,
				status: {},
				stats: {},
				endpoints: await this.endpointStateSummary(),
			};
		}
		try {
			const [status, stats] = await Promise.all([this.siteStatus(), this.forumStats()]);
			const dashboard = {
				status: safeAdminData(status),
				stats: safeAdminData(stats),
				endpoints: await this.endpointStateSummary(),
			};
			await this.updateSettings({ dashboard_status: JSON.stringify(dashboard) });
			return dashboard;
		} catch (error) {
			const cached = parseObject((await this.settings()).dashboard_status);
			if (Object.keys(cached).length) {
				return { ...cached, stale: true, warning: '[[forum-fortress:status-stale]]' };
			}
			throw error;
		}
	}

	async endpointStateSummary() {
		const settings = await this.settings();
		const state = parseObject(settings.endpoint_state);
		const endpoints = await this.checkCandidates();
		return {
			preferred: endpoints[0] || '',
			endpoints,
			endpoints_count: endpoints.length,
			last_responded: String(state.last_responded || ''),
			last_response_at: Number(state.last_response_at || 0),
			last_failure: state.last_failure || null,
			key_type: String(state.key_type || 'normal'),
			rebootstrap_at: Number(state.rebootstrap_at || 0),
			last_site_ping_at: Number(state.last_site_ping_at || 0),
			heartbeat_last_attempt_at: Number(state.heartbeat_last_attempt_at || 0),
			plan: String(state.plan_name || ''),
		};
	}

	validateSiteStatus(result) {
		const stats = result?.stats;
		if (!isObject(result)
			|| !isNonEmptyString(result.site_id)
			|| !isNonEmptyString(result.mode)
			|| !isNonEmptyString(result.plan)
			|| !isObject(result.attack_mode)
			|| typeof result.attack_mode.enabled !== 'boolean'
			|| !isObject(stats)
			|| !['current_month_checks', 'allows', 'blocks'].every(key => isFiniteNumber(stats[key]))) {
			throw new EndpointRequestError('Forum Fortress returned an invalid site status response.', { retryable: true });
		}
		return result;
	}

	validateForumStats(result) {
		if (!isObject(result) || !['current_month_checks', 'allows', 'blocks'].every(key => isFiniteNumber(result[key]))) {
			throw new EndpointRequestError('Forum Fortress returned invalid forum statistics.', { retryable: true });
		}
		return result;
	}

	validatePing(result) {
		if (!isObject(result)
			|| !isNonEmptyString(result.status)
			|| !isNonEmptyString(result.site_id)
			|| !isNonEmptyString(result.mode)
			|| !isNonEmptyString(result.plan)) {
			throw new EndpointRequestError('Forum Fortress returned an invalid connection response.', { retryable: true });
		}
		return result;
	}

	async clearIdentity() {
		await this.updateSettings({
			api_key: '',
			site_id: '',
			bootstrap_recovery_token: '',
			preferred_endpoint: '',
			endpoint_state: '{}',
			dashboard_status: '{}',
			last_bootstrap_error: '',
		});
	}

	async commonPayload() {
		const settings = await this.settings();
		return Object.fromEntries(Object.entries({
			api_key: settings.api_key,
			site_id: settings.site_id,
			domain: this.domain(),
			platform: 'nodebb',
			platform_version: this.nodeVersion,
			plugin_version: PLUGIN_VERSION,
		}).filter(([, value]) => value !== '' && value !== undefined && value !== null));
	}

	domain() {
		try {
			return new URL(this.forumUrl).hostname.toLowerCase();
		} catch (error) {
			return '';
		}
	}

	async checkCandidates() {
		const settings = await this.settings();
		return orderedCandidates(normalizeRegion(settings.api_region), isOn(settings.allow_global_fallback), settings.preferred_endpoint);
	}

	async controlCandidates() {
		return [ENDPOINTS.global];
	}

	async requestChecks(path, payload) {
		const started = this.clock();
		let lastError = null;
		for (const base of await this.checkCandidates()) {
			if (this.clock() - started >= CHECK_TOTAL_BUDGET_MS) {
				break;
			}
			try {
				const result = await this.request('POST', `${base}${path}`, payload, CHECK_ENDPOINT_TIMEOUT_MS);
				await this.recordEndpointResult(base, true);
				return result;
			} catch (error) {
				lastError = error;
				await this.recordEndpointResult(base, false, path, error);
				if (this.isStaleIdentityError(error)) {
					try {
					await this.recoverIdentityOrRestore(error);
					const retry = await this.request('POST', `${base}${path}`, {
						...payload,
						...(await this.commonPayload()),
					}, CHECK_ENDPOINT_TIMEOUT_MS);
						await this.recordEndpointResult(base, true);
						return retry;
					} catch (retryError) {
						lastError = retryError;
						await this.recordEndpointResult(base, false, path, retryError);
					}
				}
				if (error instanceof EndpointRequestError && !error.retryable) {
					throw error;
				}
			}
		}
		throw lastError || new EndpointRequestError('No Forum Fortress check endpoint is available.');
	}

	async requestWithIdentityRecovery(method, path, payloadFactory, forceBootstrap = false, timeoutOverride, regional = false, control = false) {
		try {
			await this.bootstrapIfNeeded(forceBootstrap);
		} catch (error) {
			if (!this.isStaleIdentityError(error)) {
				throw error;
			}
			await this.recoverIdentityOrRestore(error);
		}

		const candidates = control ? await this.controlCandidates() : (regional ? await this.checkCandidates() : await this.controlCandidates());
		try {
			return await this.requestAcrossCandidates(method, path, await payloadFactory(), candidates, timeoutOverride, true);
		} catch (error) {
			if (!this.isStaleIdentityError(error)) {
				throw error;
			}
			await this.recoverIdentityOrRestore(error);
			return this.requestAcrossCandidates(method, path, await payloadFactory(), control ? await this.controlCandidates() : candidates, timeoutOverride, true);
		}
	}

	async requestAcrossCandidates(method, path, payload, candidates, timeoutOverride, allowNotFoundFailover = false) {
		let lastError = null;
		for (const base of candidates) {
			try {
				const result = await this.request(method, `${base}${path}`, payload, timeoutOverride);
				await this.recordEndpointResult(base, true);
				return result;
			} catch (error) {
				lastError = error;
				await this.recordEndpointResult(base, false, path, error);
				if (error instanceof EndpointRequestError && !error.retryable && !(allowNotFoundFailover && error.statusCode === 404)) {
					throw error;
				}
			}
		}
		throw lastError || new EndpointRequestError('No Forum Fortress API endpoint is available.');
	}

	async request(method, url, payload = {}, timeoutSecondsOrMs) {
		if (typeof this.fetchImpl !== 'function') {
			throw new EndpointRequestError('Forum Fortress requires the Node.js fetch API.');
		}
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== 'https:') {
			throw new EndpointRequestError('Forum Fortress refused a non-HTTPS endpoint.', { retryable: false });
		}

		const requestMethod = String(method).toUpperCase();
		const configuredTimeout = timeoutSecondsOrMs === undefined || timeoutSecondsOrMs === null
			? asSeconds((await this.settings()).timeout)
			: timeoutSecondsOrMs;
		const timeoutMs = Math.max(100, Math.min(30000, Number(configuredTimeout) * (Number(configuredTimeout) < 100 ? 1000 : 1)));
		const body = { ...(payload || {}) };
		const headers = {
			Accept: 'application/json',
			'User-Agent': `ForumFortress-NodeBB/${PLUGIN_VERSION}`,
		};
		if (requestMethod === 'GET') {
			const apiKey = String(body.api_key || '').trim();
			if (apiKey) {
				headers['X-FF-Key'] = apiKey;
				delete body.api_key;
			}
			Object.entries(body).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== '') {
					parsedUrl.searchParams.set(key, String(value));
				}
			});
		} else {
			headers['Content-Type'] = 'application/json';
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response;
		try {
			response = await this.fetchImpl(parsedUrl, {
				method: requestMethod,
				headers,
			...(requestMethod === 'GET' ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
				redirect: 'error',
			});
		} catch (error) {
			throw new EndpointRequestError('Forum Fortress request failed or timed out.', { cause: error });
		} finally {
			clearTimeout(timer);
		}

		const statusCode = Number(response.status || 0);
		const text = await this.readResponse(response);
		let decoded;
		try {
			decoded = JSON.parse(text);
		} catch (error) {
			throw new EndpointRequestError(`Forum Fortress returned malformed JSON (HTTP ${statusCode}).`, {
				statusCode,
				retryable: (statusCode >= 200 && statusCode < 300)
					|| statusCode === 0
					|| [408, 425, 500, 502, 503, 504].includes(statusCode),
				cause: error,
			});
		}

		if (statusCode < 200 || statusCode >= 300 || !decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
			const debugSettings = await this.settings();
			if (isOn(debugSettings.debug_log) && typeof this.logger.warn === 'function') {
				this.logger.warn(`[forum-fortress] ${requestMethod} ${parsedUrl.origin}${parsedUrl.pathname} rejected: ${redact(JSON.stringify({ body, response: decoded }), debugSettings.api_key)}`);
			}
			const detailValue = decoded && typeof decoded === 'object' ? decoded.detail || decoded.error || decoded : '';
			const detail = typeof decoded?.message === 'string'
				? decoded.message
				: typeof detailValue === 'string' ? detailValue : JSON.stringify(detailValue);
			const errorCode = typeof decoded?.error === 'string'
				? decoded.error
				: detailValue && typeof detailValue === 'object'
					? String(detailValue.error || detailValue.code || '') || null
					: null;
			const retryable = statusCode >= 200 && statusCode < 300
				|| statusCode === 0
				|| [408, 425, 500, 502, 503, 504].includes(statusCode);
			throw new EndpointRequestError(`Forum Fortress returned HTTP ${statusCode} ${redact(detail, (await this.settings()).api_key)}`.trim(), {
				statusCode,
				retryable,
				errorCode,
			});
		}
		return decoded;
	}

	async readResponse(response) {
		if (response.body && typeof response.body.getReader === 'function') {
			const reader = response.body.getReader();
			const chunks = [];
			let total = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value?.byteLength || 0;
					if (total > MAX_RESPONSE_BYTES) {
						await reader.cancel();
						throw new EndpointRequestError('Forum Fortress response exceeded the maximum allowed size.', { retryable: false });
					}
					chunks.push(Buffer.from(value));
				}
				return Buffer.concat(chunks).toString('utf8');
			} finally {
				reader.releaseLock?.();
			}
		}
		const text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
			throw new EndpointRequestError('Forum Fortress response exceeded the maximum allowed size.', { retryable: false });
		}
		return text;
	}

	async persistIdentity(result, respondedBase = '', { activate = false } = {}) {
		const settings = await this.settings();
		const state = parseObject(settings.endpoint_state);
		if (result.api_key) state.key_type = String(result.key_type || state.key_type || 'normal');
		if (result.plan) state.plan_name = String(result.plan).trim().toLowerCase();
		if (result.rebootstrap_after_seconds !== undefined) {
			state.rebootstrap_at = nowSeconds(this.clock) + Math.max(60, Number(result.rebootstrap_after_seconds) || 0);
		} else if (!String(result.api_key || settings.api_key).startsWith('ff_ob_')) {
			state.rebootstrap_at = 0;
		}
		const endpoint = respondedBase || (await this.checkCandidates())[0] || '';
		if (endpoint) {
			state.last_responded = endpoint;
			state.last_response_at = nowSeconds(this.clock);
		}
		await this.updateSettings({
			...(result.api_key ? { api_key: String(result.api_key).trim() } : {}),
			...(result.site_id ? { site_id: String(result.site_id).trim() } : {}),
			bootstrap_recovery_token: '',
			last_bootstrap_error: '',
			...(activate ? { bootstrap_suppressed: 'off', enabled: 'on' } : {}),
			preferred_endpoint: endpoint,
			endpoint_state: JSON.stringify(state),
		});
	}

	async persistObservedStatus(result) {
		const settings = await this.settings();
		const state = parseObject(settings.endpoint_state);
		state.plan_name = String(result.plan).trim().toLowerCase();
		const endpoint = (await this.checkCandidates())[0] || '';
		if (endpoint) {
			state.last_responded = endpoint;
			state.last_response_at = nowSeconds(this.clock);
		}
		await this.updateSettings({
			...(result.site_id ? { site_id: String(result.site_id).trim() } : {}),
			preferred_endpoint: endpoint || settings.preferred_endpoint,
			endpoint_state: JSON.stringify(state),
		});
	}

	async recordEndpointResult(base, success, path = '', error = null) {
		const settings = await this.settings();
		const state = parseObject(settings.endpoint_state);
		if (success) {
			state.last_responded = base;
			state.last_response_at = nowSeconds(this.clock);
			delete state.last_failure;
		} else {
			state.last_failure = {
				base,
				path,
				at: nowSeconds(this.clock),
				message: redact(error?.message || '', settings.api_key).slice(0, 200),
			};
		}
		await this.updateSettings({ endpoint_state: JSON.stringify(state), preferred_endpoint: success ? base : settings.preferred_endpoint });
	}

	async bootstrapRecoveryToken() {
		const settings = await this.settings();
		if (settings.bootstrap_recovery_token && settings.bootstrap_recovery_token.length >= 32) {
			return settings.bootstrap_recovery_token;
		}
		const token = `ff_br_${randomBytes(32).toString('base64url')}`;
		await this.updateSettings({ bootstrap_recovery_token: token });
		return token;
	}

	async heartbeatIsDue() {
		const settings = await this.settings();
		const state = parseObject(settings.endpoint_state);
		const plan = String(state.plan_name || '').toLowerCase();
		const interval = ['pro', 'multimod'].includes(plan) ? PRO_HEARTBEAT_SECONDS : STANDARD_HEARTBEAT_SECONDS;
		return Number(state.heartbeat_last_attempt_at || 0) <= 0
			|| nowSeconds(this.clock) - Number(state.heartbeat_last_attempt_at) >= interval;
	}

	isStaleIdentityError(error) {
		const code = String(error?.errorCode || '').toLowerCase();
		const message = String(error?.message || '').toLowerCase();
		return error?.statusCode === 401
			|| ['invalid_key', 'invalid_api_key', 'node_mismatch', 'stale_site', 'site_not_found'].includes(code)
			|| message.includes('node_mismatch')
			|| message.includes('api key not recognised');
	}

	isAlreadyRemovedError(error) {
		return [404, 410].includes(error?.statusCode)
			&& String(error?.errorCode || '').toLowerCase() === 'site_not_found';
	}

	async recoverIdentityOrRestore(error) {
		const settings = await this.settings();
		const names = ['api_key', 'site_id', 'bootstrap_recovery_token', 'preferred_endpoint', 'endpoint_state', 'dashboard_status', 'enabled', 'bootstrap_suppressed'];
		const snapshot = Object.fromEntries(names.map(name => [name, settings[name]]));
		if (String(error?.errorCode || '').toLowerCase() === 'stale_site') {
			await this.updateSettings({ site_id: '', dashboard_status: '{}' });
		} else {
			await this.clearIdentity();
		}
		try {
			await this.bootstrapIfNeeded(true);
		} catch (recoveryError) {
			await this.updateSettings(snapshot);
			throw recoveryError;
		}
	}

	logFailure(operation, error) {
		if (!error) return;
		this.settings().then((settings) => {
			if (isOn(settings.debug_log) && typeof this.logger.warn === 'function') {
				this.logger.warn(`[forum-fortress] ${operation} failed: ${redact(error.message, settings.api_key)}. Support: ${SUPPORT_URL}`);
			}
		}).catch(() => {});
	}
}

module.exports = {
	EndpointRequestError,
	ForumFortressClient,
	MAX_RESPONSE_BYTES,
	PLUGIN_VERSION,
	SUPPORT_URL,
	safeAdminData,
};
