'use strict';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)}\]]$/u;

function normalizeDomain(value) {
	return String(value || '').trim().toLowerCase().replace(/\.$/u, '');
}

function isOwnHost(hostname, forumDomain) {
	const host = normalizeDomain(hostname);
	const domain = normalizeDomain(forumDomain);
	return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
}

function extractExternalLinks(content, forumDomain) {
	const links = [];
	const seen = new Set();
	const text = String(content || '');

	for (const match of text.matchAll(URL_PATTERN)) {
		let candidate = match[0];
		while (TRAILING_PUNCTUATION.test(candidate)) {
			candidate = candidate.slice(0, -1);
		}
		try {
			const parsed = new URL(candidate);
			if (!['http:', 'https:'].includes(parsed.protocol) || isOwnHost(parsed.hostname, forumDomain)) {
				continue;
			}
			if (!seen.has(candidate)) {
				seen.add(candidate);
				links.push(candidate);
			}
		} catch (error) {
			// The expression is intentionally conservative; malformed candidates are ignored.
		}
	}

	return links;
}

module.exports = { extractExternalLinks, isOwnHost };
