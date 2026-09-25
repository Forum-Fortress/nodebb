'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRemoteEvent, isRemoteIdentifier } = require('../lib/activitypub');
const { ForumFortressClient } = require('../lib/client');
const { assertAllowed, UnavailableError } = require('../lib/decisions');
const { ENDPOINTS, orderedCandidates } = require('../lib/endpoints');
const { extractExternalLinks } = require('../lib/links');
const { DEFAULT_SETTINGS, SETTINGS_KEY } = require('../lib/settings');
const { portalUrlIsTrusted } = require('../lib/controllers');
const plugin = require('../library');

function makeStore(values = {}) {
	const state = { ...DEFAULT_SETTINGS, ...values };
	return {
		async get(key) {
			assert.equal(key, SETTINGS_KEY);
			return { ...state };
		},
		async set(key, patch) {
			assert.equal(key, SETTINGS_KEY);
			Object.assign(state, patch);
		},
		async setOnEmpty(key, defaults) {
			assert.equal(key, SETTINGS_KEY);
			Object.keys(defaults).forEach((name) => {
				if (state[name] === undefined) state[name] = defaults[name];
			});
		},
		state,
	};
}

function jsonResponse(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeClient(values, responder, options = {}) {
	const store = makeStore(values);
	const calls = [];
	const client = new ForumFortressClient({
		settingsStore: store,
		forumUrl: 'https://community.example.test',
		nodeVersion: 'v22.0.0',
		clock: () => 1_700_000_000_000,
		fetchImpl: async (url, options) => {
			calls.push({ url: String(url), options });
			return responder(String(url), options, calls.length);
		},
		logger: { warn() {} },
		...options,
	});
	return { client, calls, store };
}

function siteStatus(overrides = {}) {
	return {
		site_id: 'site_test',
		mode: 'anonymous',
		plan: 'free',
		attack_mode: { enabled: false },
		stats: { current_month_checks: 0, allows: 0, blocks: 0 },
		...overrides,
	};
}

function forumStats(overrides = {}) {
	return {
		current_month_checks: 0,
		allows: 0,
		blocks: 0,
		...overrides,
	};
}

test('extracts external links while excluding the forum and subdomains', () => {
	assert.deepEqual(extractExternalLinks(
		'Local https://community.example.test/docs and https://sub.community.example.test/x; external https://example.org/a, https://example.org/a.]',
		'community.example.test',
	), ['https://example.org/a']);
});

test('recognizes ActivityPub identifiers and skips remote events', () => {
	assert.equal(isRemoteIdentifier('https://remote.example/users/alice'), true);
	assert.equal(isRemoteIdentifier('acct:alice@remote.example'), true);
	assert.equal(isRemoteIdentifier('42'), false);
	assert.equal(isRemoteEvent({ post: { tid: 'https://remote.example/t/1' } }), true);
	assert.equal(isRemoteEvent({ data: { _activitypub: true } }), true);
	assert.equal(isRemoteEvent({ post: { uid: 42, tid: 7, pid: 9 } }), false);
});

test('uses selected regional endpoint and optional global fallback', () => {
	assert.deepEqual(orderedCandidates('eu', false), [ENDPOINTS.eu]);
	assert.deepEqual(orderedCandidates('eu', true), [ENDPOINTS.eu, ENDPOINTS.global]);
	assert.deepEqual(orderedCandidates('eu', true, ENDPOINTS.global), [ENDPOINTS.global, ENDPOINTS.eu]);
	assert.deepEqual(orderedCandidates('not-a-region', false), [ENDPOINTS.global]);
});

test('allows allow and review decisions and blocks only block', () => {
	assert.doesNotThrow(() => assertAllowed({ decision: 'allow' }));
	assert.doesNotThrow(() => assertAllowed({ decision: 'review' }));
	assert.throws(() => assertAllowed({ decision: 'block' }), /blocked/iu);
	assert.throws(() => assertAllowed({ decision: 'unexpected' }), UnavailableError);
});

test('NodeBB filters preserve the payload object on pass-through paths', async () => {
	const registration = {};
	const postCreate = { post: { content: '' }, data: {} };
	const postEdit = { post: {}, data: {} };
	const profile = { data: {} };
	assert.equal(await plugin.checkRegistration(registration), registration);
	assert.equal(await plugin.checkPostCreate(postCreate), postCreate);
	assert.equal(await plugin.checkPostEdit(postEdit), postEdit);
	assert.equal(await plugin.checkProfile(profile), profile);
});

test('checks the actual NodeBB HTTP registration hook payload', async () => {
	const originalCheck = plugin.client.check;
	let captured;
	plugin.client.check = async (eventType, payload) => {
		captured = { eventType, payload };
		return { decision: 'allow' };
	};
	const hook = {
		req: { ip: '203.0.113.42', headers: { 'user-agent': 'NodeBB registration test' } },
		userData: { username: 'new-member', email: 'new-member@example.test' },
	};
	try {
		assert.equal(await plugin.checkRegistration(hook), hook);
	} finally {
		plugin.client.check = originalCheck;
	}
	assert.deepEqual(captured, {
		eventType: 'register',
		payload: {
			username: 'new-member',
			email: 'new-member@example.test',
			account_age_seconds: 0,
			post_count: 0,
			ip: '203.0.113.42',
			user_agent: 'NodeBB registration test',
		},
	});
	assert.equal(require('../plugin.json').hooks.some(hook => hook.hook === 'filter:register.check'), true);
});

test('bootstraps through the live generic route and persists identity before checking', async () => {
	const { client, calls, store } = makeClient({}, (url) => {
		if (url.endsWith('/v1/site/bootstrap')) {
			return jsonResponse({ api_key: 'ff_ob_test', site_id: 'site_test', plan: 'standard' });
		}
		if (url.endsWith('/v1/check/reply')) return jsonResponse({ decision: 'allow' });
		throw new Error(`unexpected URL ${url}`);
	});

	const result = await client.check('reply', { content: 'hello' });
	assert.equal(result.decision, 'allow');
	assert.equal(store.state.api_key, 'ff_ob_test');
	assert.equal(store.state.site_id, 'site_test');
	assert.equal(calls.some(call => call.url.endsWith('/v1/site/flarum/bootstrap')), false);
	assert.equal(calls[0].url, `${ENDPOINTS.global}/v1/site/bootstrap`);
	assert.equal(JSON.parse(calls[0].options.body).platform, 'nodebb');
	assert.equal(JSON.parse(calls[0].options.body).domain, 'community.example.test');
	assert.equal(JSON.parse(calls[0].options.body).bootstrap_recovery_token, undefined);
});

test('falls back to the dedicated NodeBB route when the generic route is unavailable', async () => {
	const { client, calls, store } = makeClient({}, (url) => {
		if (url.endsWith('/v1/site/bootstrap')) {
			return jsonResponse({ error: 'not_found', message: 'Resource not found' }, 404);
		}
		if (url.endsWith('/v1/site/nodebb/bootstrap')) {
			return jsonResponse({ api_key: 'ff_ob_test', site_id: 'site_test', plan: 'standard' });
		}
		throw new Error(`unexpected URL ${url}`);
	});

	await client.bootstrapIfNeeded(true);
	assert.equal(store.state.api_key, 'ff_ob_test');
	assert.deepEqual(calls.map(call => call.url), [
		`${ENDPOINTS.global}/v1/site/bootstrap`,
		`${ENDPOINTS.global}/v1/site/nodebb/bootstrap`,
	]);
});

test('recovers a stale API identity and retries with the new key', async () => {
	const { client, calls, store } = makeClient({ api_key: 'ff_ob_old', site_id: 'site_old' }, (url) => {
		if (url.endsWith('/v1/check/reply') && calls.length === 1) {
			return jsonResponse({ detail: { error: 'invalid_key' } }, 401);
		}
		if (url.endsWith('/v1/site/bootstrap')) {
			return jsonResponse({ error: 'not_found', message: 'Resource not found' }, 404);
		}
		if (url.endsWith('/v1/site/nodebb/bootstrap')) {
			return jsonResponse({ api_key: 'ff_ob_new', site_id: 'site_new' });
		}
		if (url.endsWith('/v1/check/reply')) return jsonResponse({ decision: 'allow' });
		throw new Error(`unexpected URL ${url}`);
	});

	assert.equal((await client.check('reply', { content: 'hello' })).decision, 'allow');
	assert.equal(store.state.api_key, 'ff_ob_new');
	assert.equal(store.state.site_id, 'site_new');
	assert.deepEqual(calls.map(call => call.url), [
		`${ENDPOINTS.global}/v1/check/reply`,
		`${ENDPOINTS.global}/v1/site/bootstrap`,
		`${ENDPOINTS.global}/v1/site/nodebb/bootstrap`,
		`${ENDPOINTS.global}/v1/check/reply`,
	]);
	assert.equal(JSON.parse(calls[3].options.body).api_key, 'ff_ob_new');
});

test('fails open by default and fails closed when configured', async () => {
	const open = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test' }, () => {
		throw new Error('network down');
	});
	assert.equal(await open.client.check('reply', { content: 'hello' }), null);

	const closed = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test', fail_open: 'off' }, () => {
		throw new Error('network down');
	});
	await assert.rejects(() => closed.client.check('reply', { content: 'hello' }), UnavailableError);
});

test('rejects malformed success responses as unavailable', async () => {
	const closed = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test', fail_open: 'off' }, () => new Response('not-json', { status: 200 }));
	await assert.rejects(() => closed.client.check('reply', { content: 'hello' }), UnavailableError);
});

test('does not re-enable protection when status is observed directly', async () => {
	const { client, store } = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test', enabled: 'off' }, (url) => {
		assert.match(url, /\/v1\/site\/status/u);
		return jsonResponse(siteStatus());
	});
	await client.siteStatus();
	assert.equal(store.state.enabled, 'off');
	assert.equal(store.state.bootstrap_suppressed, 'off');
});

test('does not contact the service or reactivate protection from a disabled dashboard', async () => {
	const { client, calls, store } = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test', enabled: 'off' }, () => {
		throw new Error('dashboard must not make a request while disabled');
	});
	const dashboard = await client.dashboard();
	assert.equal(dashboard.disabled, true);
	assert.equal(calls.length, 0);
	assert.equal(store.state.enabled, 'off');
});

test('accepts contract-complete site status and usage responses', async () => {
	const { client } = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test' }, (url) => (
		jsonResponse(url.includes('/v1/site/status') ? siteStatus() : forumStats())
	));
	const dashboard = await client.dashboard();
	assert.equal(dashboard.status.site_id, 'site_test');
	assert.equal(dashboard.stats.current_month_checks, 0);
});

test('rejects incomplete 2xx status and statistics payloads', async () => {
	const invalidStatus = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test' }, () => jsonResponse({}));
	await assert.rejects(() => invalidStatus.client.siteStatus(), /invalid site status response/u);

	const invalidStats = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test' }, () => jsonResponse({ current_month_checks: 0 }));
	await assert.rejects(() => invalidStats.client.forumStats(), /invalid forum statistics/u);
});

test('requires an explicit boolean attack-mode confirmation', async () => {
	const { client } = makeClient({ api_key: 'ff_ob_test', site_id: 'site_test' }, () => jsonResponse({}));
	await assert.rejects(() => client.setAttackMode(false), /attack-end-unconfirmed/u);
});

test('coordinates bootstrap across NodeBB workers with a shared lease', async () => {
	const state = { ...DEFAULT_SETTINGS };
	const sharedSettings = {
		async get(key) {
			assert.equal(key, SETTINGS_KEY);
			return { ...state };
		},
		async set(key, patch) {
			assert.equal(key, SETTINGS_KEY);
			Object.assign(state, patch);
		},
	};
	const locks = new Map();
	const database = {
		async increment(key) {
			const next = Number(locks.get(key) || 0) + 1;
			locks.set(key, next);
			return next;
		},
		async expire() {},
		async delete(key) { locks.delete(key); },
	};
	let bootstrapCalls = 0;
	let allowBootstrap;
	const bootstrapStarted = new Promise(resolve => {
		allowBootstrap = resolve;
	});
	let started;
	const bootstrapIsRunning = new Promise(resolve => { started = resolve; });
	const responder = async (url) => {
		assert.match(url, /\/v1\/site\/bootstrap$/u);
		bootstrapCalls += 1;
		started();
		await bootstrapStarted;
		return jsonResponse({ api_key: 'ff_ob_shared', site_id: 'site_shared' });
	};
	const options = {
		settingsStore: sharedSettings,
		database,
		forumUrl: 'https://community.example.test',
		bootstrapLockWaitMs: 100,
		bootstrapLockRetryMs: 1,
		fetchImpl: async (url) => responder(String(url)),
		logger: { warn() {} },
	};
	const first = new ForumFortressClient(options);
	const second = new ForumFortressClient(options);
	const firstBootstrap = first.bootstrapIfNeeded();
	await bootstrapIsRunning;
	const secondBootstrap = second.bootstrapIfNeeded();
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(bootstrapCalls, 1);
	allowBootstrap();
	await Promise.all([firstBootstrap, secondBootstrap]);
	assert.equal(state.api_key, 'ff_ob_shared');
	assert.equal(state.site_id, 'site_shared');
});

test('keeps portal redirects on the Forum Fortress HTTPS allowlist', () => {
	assert.equal(portalUrlIsTrusted('https://forumfortress.com/access?token=abc'), true);
	assert.equal(portalUrlIsTrusted('https://portal.ffapi.net/access?token=abc'), true);
	assert.equal(portalUrlIsTrusted('http://forumfortress.com/access?token=abc'), false);
	assert.equal(portalUrlIsTrusted('https://evil.example/access?token=abc'), false);
	assert.equal(portalUrlIsTrusted('https://forumfortress.com/access?token=abc#unsafe'), false);
});
