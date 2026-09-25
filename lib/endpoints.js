'use strict';

const ENDPOINTS = Object.freeze({
	global: 'https://api.ffapi.net',
	uk: 'https://api-uk.ffapi.net',
	eu: 'https://api-eu.ffapi.net',
	us: 'https://api-us.ffapi.net',
});

function normalizeRegion(region) {
	const value = String(region || '').trim().toLowerCase();
	return Object.hasOwn(ENDPOINTS, value) ? value : 'global';
}

function normalizeEndpoint(value) {
	const candidate = String(value || '').trim().replace(/\/+$/u, '');
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
			return '';
		}
		return parsed.toString().replace(/\/+$/u, '');
	} catch (error) {
		return '';
	}
}

function orderedCandidates(region, allowGlobalFallback, preferred = '') {
	const normalizedRegion = normalizeRegion(region);
	const primary = ENDPOINTS[normalizedRegion];
	const permitted = normalizedRegion === 'global' || allowGlobalFallback
		? [primary, ENDPOINTS.global]
		: [primary];
	const preferredEndpoint = normalizeEndpoint(preferred);
	const ordered = preferredEndpoint && permitted.includes(preferredEndpoint)
		? [preferredEndpoint, ...permitted]
		: permitted;
	return [...new Set(ordered)];
}

module.exports = { ENDPOINTS, normalizeEndpoint, normalizeRegion, orderedCandidates };
