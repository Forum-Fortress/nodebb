'use strict';

const cron = (() => {
	try {
		return require.main && require.main.require('./src/cron');
	} catch (error) {
		return null;
	}
})();
const meta = (() => {
	try {
		return require.main && require.main.require('./src/meta');
	} catch (error) {
		return null;
	}
})();
const routeHelpers = (() => {
	try {
		return require.main && require.main.require('./src/routes/helpers');
	} catch (error) {
		return null;
	}
})();
const user = (() => {
	try {
		return require.main && require.main.require('./src/user');
	} catch (error) {
		return null;
	}
})();
const posts = (() => {
	try {
		return require.main && require.main.require('./src/posts');
	} catch (error) {
		return null;
	}
})();
const topics = (() => {
	try {
		return require.main && require.main.require('./src/topics');
	} catch (error) {
		return null;
	}
})();

const { assertAllowed } = require('./lib/decisions');
const { isRemoteEvent, isRemoteIdentifier } = require('./lib/activitypub');
const { extractExternalLinks } = require('./lib/links');
const { ensureSettings } = require('./lib/settings');
const { actorUid, buildUserPayload, requestContext } = require('./lib/payload');
const { ForumFortressClient } = require('./lib/client');
const { createControllers } = require('./lib/controllers');

const client = new ForumFortressClient();
const controllers = createControllers(client);
let heartbeatPromise = null;

function safeString(value) {
	return String(value ?? '').trim();
}

async function isAdministrator(hook) {
	const uid = actorUid(hook);
	return Number(uid) > 0 && typeof user?.isAdministrator === 'function' && await user.isAdministrator(uid);
}

function hasExplicitSystemMarker(hook) {
	return Boolean(
		hook.system
		|| hook.data?.system
		|| hook.data?.fromSystem
		|| hook.data?.internal
		|| hook.opts?.system
		|| hook.opts?.internal
	);
}

function hasReliableRegistrationContext(hook) {
	const context = requestContext(hook);
	return Boolean(context && (context.headers || context.ip || context.uid !== undefined));
}

async function checkRegistration(hook = {}) {
	if (hasExplicitSystemMarker(hook) || await isAdministrator(hook)) {
		return hook;
	}
	// filter:register.check is the NodeBB HTTP registration boundary. Keep the
	// request-context guard so internal callers cannot accidentally be treated as
	// a public registration if a future NodeBB release reuses this hook.
	if (!hasReliableRegistrationContext(hook)) {
		return hook;
	}

	const response = await client.check('register', await buildUserPayload(hook, user, {
		uid: 0,
		overrides: {
			account_age_seconds: 0,
			post_count: 0,
		},
	}));
	assertAllowed(response);
	return hook;
}

async function postPayload(hook, action, isTopic, content, title = '') {
	const checked = title ? `${title}\n\n${content}` : content;
	return client.check(isTopic ? 'topic' : 'reply', await buildUserPayload(hook, user, {
		uid: hook.data?.uid ?? hook.post?.uid,
		overrides: {
			content: checked,
			links: extractExternalLinks(checked, client.domain()),
			content_id: hook.post?.pid ?? hook.data?.pid,
			thread_id: hook.post?.tid ?? hook.data?.tid,
			action,
		},
	}));
}

async function checkPostCreate(hook = {}) {
	if (isRemoteEvent(hook) || await isAdministrator(hook)) {
		return hook;
	}
	const post = hook.post || {};
	const data = hook.data || {};
	const body = safeString(post.sourceContent ?? data.sourceContent ?? post.content ?? data.content);
	if (!body) {
		return hook;
	}
	const isTopic = Boolean(data.isMain || post.isMain);
	const title = isTopic ? safeString(data.title || post.title) : '';
	assertAllowed(await postPayload(hook, 'create', isTopic, body, title));
	return hook;
}

async function editContext(hook) {
	const data = hook.data || {};
	const post = hook.post || {};
	if (!posts || !topics || data.pid === undefined) {
		return {
			oldPost: {},
			isTopic: Boolean(data.isMain || post.isMain),
			oldTitle: '',
			tid: post.tid || data.tid,
		};
	}
	const oldPost = await posts.getPostData(data.pid) || {};
	const topicData = oldPost.tid === undefined
		? {}
		: await topics.getTopicFields(oldPost.tid, ['mainPid', 'title']);
	return {
		oldPost,
		isTopic: String(data.pid) === String(topicData.mainPid),
		oldTitle: safeString(topicData.title),
		tid: oldPost.tid,
	};
}

async function checkPostEdit(hook = {}) {
	if (isRemoteEvent(hook) || await isAdministrator(hook)) {
		return hook;
	}
	const data = hook.data || {};
	const post = hook.post || {};
	const context = await editContext(hook);
	const newBody = safeString(data.sourceContent ?? data.content ?? post.sourceContent ?? post.content);
	const oldBody = safeString(context.oldPost.sourceContent ?? context.oldPost.content);
	const newTitle = context.isTopic && data.title !== undefined ? safeString(data.title) : context.oldTitle;
	const titleChanged = context.isTopic && newTitle !== context.oldTitle;
	if (!newBody || (newBody === oldBody && !titleChanged)) {
		return hook;
	}

	const checkedHook = {
		...hook,
		post: { ...post, tid: context.tid || post.tid },
		data: { ...data, tid: context.tid || data.tid },
	};
	assertAllowed(await postPayload(checkedHook, 'edit', context.isTopic, newBody, context.isTopic ? newTitle : ''));
	return hook;
}

async function checkProfile(hook = {}) {
	if (await isAdministrator(hook)) {
		return hook;
	}
	const data = hook.data || {};
	if (isRemoteIdentifier(data.uid)) {
		return hook;
	}
	const profile = ['username', 'fullname', 'signature', 'aboutme']
		.filter(field => data[field] !== undefined)
		.map(field => safeString(data[field]))
		.filter(Boolean);
	if (!profile.length) {
		return hook;
	}
	const content = profile.join('\n');
	assertAllowed(await client.check('profile', await buildUserPayload(hook, user, {
		uid: data.uid,
		overrides: {
			content,
			links: extractExternalLinks(content, client.domain()),
		},
	})));
	return hook;
}

async function init({ router }) {
	try {
		if (meta?.settings) {
			await ensureSettings(meta.settings);
		}
		if (routeHelpers?.setupAdminPageRoute && router) {
			routeHelpers.setupAdminPageRoute(router, '/admin/plugins/forum-fortress', controllers.page);
		}
		registerHeartbeat();
	} catch (error) {
		// The plugin must never prevent NodeBB startup when the service is offline.
		try {
			console.warn(`[forum-fortress] startup setup failed: ${error.message}`);
		} catch (ignored) {}
	}
}

function registerHeartbeat() {
	if (!cron?.addJob || cron.hasJob?.('forum-fortress-heartbeat')) {
		return;
	}
	cron.addJob({
		name: 'forum-fortress-heartbeat',
		cronTime: '*/10 * * * *',
		async onTick() {
			if (heartbeatPromise) {
				return heartbeatPromise;
			}
			heartbeatPromise = client.sync(false)
				.catch((error) => {
					client.logFailure('heartbeat', error);
					return undefined;
				})
				.finally(() => { heartbeatPromise = null; });
			return heartbeatPromise;
		},
	});
}

function addAdminNavigation(data = {}) {
	data.plugins = Array.isArray(data.plugins) ? data.plugins : [];
	if (!data.plugins.some(item => item && item.route === '/plugins/forum-fortress')) {
		data.plugins.push({
			route: '/plugins/forum-fortress',
			icon: 'fa-shield-alt',
			name: '[[forum-fortress:name]]',
		});
	}
	return data;
}

async function addApiRoutes({ router, middleware }) {
	if (!routeHelpers?.setupApiRoute || !router) {
		return;
	}
	const admin = [middleware.ensureLoggedIn, controllers.ensureAdmin];
	const add = (method, path, handler) => routeHelpers.setupApiRoute(router, method, path, admin, handler);
	add('get', '/forum-fortress/status', controllers.status);
	add('post', '/forum-fortress/test', controllers.connectionTest);
	add('post', '/forum-fortress/register', controllers.register);
	add('post', '/forum-fortress/attack-mode', controllers.attackStart);
	add('post', '/forum-fortress/attack-mode/end', controllers.attackEnd);
	add('post', '/forum-fortress/portal', controllers.portal);
	add('post', '/forum-fortress/sync', controllers.synchronize);
	add('post', '/forum-fortress/deprovision', controllers.deprovision);
}

module.exports = {
	init,
	addApiRoutes,
	addAdminNavigation,
	checkRegistration,
	checkPostCreate,
	checkPostEdit,
	checkProfile,
	client,
	registerHeartbeat,
};
