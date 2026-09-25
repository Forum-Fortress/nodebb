'use strict';

const SETTINGS_KEY = 'forum-fortress';

const DEFAULT_SETTINGS = Object.freeze({
	enabled: 'on',
	api_region: 'global',
	allow_global_fallback: 'off',
	api_key: '',
	site_id: '',
	bootstrap_recovery_token: '',
	bootstrap_suppressed: 'off',
	preferred_endpoint: '',
	endpoint_state: '{}',
	dashboard_status: '{}',
	last_bootstrap_error: '',
	last_bootstrap_at: '0',
	last_background_recovery_at: '0',
	registration_email: '',
	timeout: '5',
	fail_open: 'on',
	debug_log: 'off',
});

function isOn(value) {
	return value === true || value === 1 || value === '1' || value === 'on' || value === 'true';
}

function asSeconds(value, fallback = 5) {
	const number = Number.parseInt(String(value), 10);
	return Number.isFinite(number) ? Math.max(1, Math.min(30, number)) : fallback;
}

function parseObject(value, fallback = {}) {
	try {
		const parsed = JSON.parse(String(value || ''));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
	} catch (error) {
		return fallback;
	}
}

async function getSettings(store) {
	const current = await store.get(SETTINGS_KEY);
	return { ...DEFAULT_SETTINGS, ...(current && typeof current === 'object' ? current : {}) };
}

async function ensureSettings(store) {
	if (typeof store.setOnEmpty === 'function') {
		await store.setOnEmpty(SETTINGS_KEY, { ...DEFAULT_SETTINGS });
		return getSettings(store);
	}

	const current = await store.get(SETTINGS_KEY);
	const missing = {};
	Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
		if (!current || !Object.hasOwn(current, key)) {
			missing[key] = value;
		}
	});
	if (Object.keys(missing).length) {
		await store.set(SETTINGS_KEY, missing);
	}
	return getSettings(store);
}

async function patchSettings(store, values) {
	const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
	if (Object.keys(patch).length) {
		await store.set(SETTINGS_KEY, patch);
	}
	return getSettings(store);
}

module.exports = {
	DEFAULT_SETTINGS,
	SETTINGS_KEY,
	asSeconds,
	ensureSettings,
	getSettings,
	isOn,
	parseObject,
	patchSettings,
};
