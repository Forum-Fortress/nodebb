'use strict';

function requestContext(event = {}) {
	return event.req || event.data?.req || event.caller?.req || {};
}

function actorUid(event = {}) {
	const context = requestContext(event);
	return event.uid ?? event.caller?.uid ?? context.uid ?? 0;
}

function requestUserAgent(event = {}) {
	const headers = requestContext(event).headers || {};
	return String(headers['user-agent'] || headers['User-Agent'] || '').slice(0, 500);
}

function accountAgeSeconds(joindate) {
	const value = Number(joindate);
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	const joinedAtMs = value < 100000000000 ? value * 1000 : value;
	return Math.max(0, Math.floor((Date.now() - joinedAtMs) / 1000));
}

async function loadUserFields(userModule, uid) {
	if (!userModule || Number(uid) <= 0 || typeof userModule.getUserFields !== 'function') {
		return {};
	}
	return userModule.getUserFields(uid, ['username', 'email', 'joindate', 'postcount']);
}

async function buildUserPayload(event, userModule, { uid, overrides = {} } = {}) {
	const actualUid = uid ?? event.data?.uid ?? event.post?.uid ?? actorUid(event);
	const stored = await loadUserFields(userModule, actualUid);
	const context = requestContext(event);
	const userData = event.userData || event.user || event.post?.user || event.data || {};
	const email = stored.email || event.data?.email || userData.email || '';
	const username = stored.username || userData.username || event.data?.handle || '';
	const postCount = stored.postcount ?? stored.postCount ?? userData.postcount ?? userData.postCount ?? 0;
	const userAgent = requestUserAgent(event);

	return {
		username: String(username || ''),
		email: String(email || ''),
		account_age_seconds: accountAgeSeconds(stored.joindate ?? userData.joindate),
		post_count: Number.isFinite(Number(postCount)) ? Number(postCount) : 0,
		...(context.ip ? { ip: String(context.ip) } : {}),
		...(userAgent ? { user_agent: userAgent } : {}),
		...overrides,
	};
}

module.exports = {
	actorUid,
	buildUserPayload,
	requestContext,
};
