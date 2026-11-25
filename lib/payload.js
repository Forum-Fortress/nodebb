'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { forwardingHeaders, resolveClientIp } = require('./client-ip');

const httpContext = new AsyncLocalStorage();

function captureHttpRequest(req, _res, next) {
	if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
		return next();
	}
	// NodeBB passes only selected request fields to some write hooks and no
	// request to the profile hook. Retain the network fields for this request.
	const headers = Object.fromEntries(['user-agent', ...forwardingHeaders].map(name => [name, req.headers[name]]));
	return httpContext.run({ ip: req.ip, socket: { remoteAddress: req.socket.remoteAddress }, headers }, next);
}

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

async function buildUserPayload(event, userModule, { uid, nativeIp, overrides = {} } = {}) {
	const actualUid = uid ?? event.data?.uid ?? event.post?.uid ?? actorUid(event);
	const stored = await loadUserFields(userModule, actualUid);
	const context = requestContext(event);
	const userData = event.userData || event.user || event.post?.user || event.data || {};
	const email = stored.email || event.data?.email || userData.email || '';
	const username = stored.username || userData.username || event.data?.handle || '';
	const postCount = stored.postcount ?? stored.postCount ?? userData.postcount ?? userData.postCount ?? 0;
	// Approval requests belong to the moderator, while the stored post and
	// any native IP belong to the original author.
	const request = event.data?.fromQueue ? undefined : httpContext.getStore();
	const userAgent = requestUserAgent(event) || String(request?.headers['user-agent'] || '').slice(0, 500);
	const ip = resolveClientIp(request || context, nativeIp ?? context.ip);

	return {
		username: String(username || ''),
		email: String(email || ''),
		account_age_seconds: accountAgeSeconds(stored.joindate ?? userData.joindate),
		post_count: Number.isFinite(Number(postCount)) ? Number(postCount) : 0,
		...(ip ? { ip } : {}),
		...(userAgent ? { user_agent: userAgent } : {}),
		...overrides,
	};
}

module.exports = {
	actorUid,
	buildUserPayload,
	captureHttpRequest,
	requestContext,
};
