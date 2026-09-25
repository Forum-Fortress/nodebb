'use strict';

const { safeAdminData } = require('./client');

function tryRequire(path) {
	try {
		return require.main && require.main.require(path);
	} catch (error) {
		return null;
	}
}

function portalUrlIsTrusted(value) {
	try {
		const parsed = new URL(String(value || ''));
		const host = parsed.hostname.toLowerCase();
		const trustedHost = host === 'forumfortress.com'
			|| host.endsWith('.forumfortress.com')
			|| host === 'ffapi.net'
			|| host.endsWith('.ffapi.net');
		return parsed.protocol === 'https:'
			&& trustedHost
			&& (parsed.port === '' || parsed.port === '443')
			&& !parsed.username
			&& !parsed.password
			&& !parsed.hash
			&& parsed.pathname.replace(/\/+$/u, '') === '/access'
			&& Boolean(parsed.searchParams.get('token'));
	} catch (error) {
		return false;
	}
}

function createControllers(client) {
	const helpers = tryRequire('./src/controllers/helpers');
	const user = tryRequire('./src/user');

	async function send(res, status, payload) {
		if (helpers?.formatApiResponse) {
			return helpers.formatApiResponse(status, res, payload);
		}
		return res.status(status).json(payload || {});
	}

	async function page(req, res) {
		return res.render('admin/plugins/forum-fortress', {
			title: '[[forum-fortress:title]]',
		});
	}

	async function status(req, res) {
		return send(res, 200, await client.dashboard());
	}

	async function connectionTest(req, res) {
		if (!await client.isEnabled()) {
			return send(res, 409, new Error('[[forum-fortress:protection-disabled]]'));
		}
		const connection = await client.confirmConnection(2);
		const [siteStatus, stats] = await Promise.all([client.siteStatus(2), client.forumStats()]);
		return send(res, 200, {
			connection: safeAdminData(connection),
			endpoint: (await client.endpointStateSummary()).last_responded,
			status: safeAdminData(siteStatus),
			stats: safeAdminData(stats),
		});
	}

	async function register(req, res) {
		const settings = await client.settings();
		const email = String(req.body?.email || settings.registration_email || '').trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
			return send(res, 400, new Error('[[forum-fortress:invalid-email]]'));
		}
		return send(res, 200, safeAdminData(await client.registerSite(email)));
	}

	async function attackMode(req, res, enabled) {
		return send(res, 200, await client.setAttackMode(enabled));
	}

	async function portal(req, res) {
		const result = await client.portalLaunch();
		if (!portalUrlIsTrusted(result.portal_url)) {
			return send(res, 502, new Error('[[forum-fortress:portal-invalid]]'));
		}
		return send(res, 200, { portal_url: result.portal_url });
	}

	async function synchronize(req, res) {
		const site = await client.sync(true);
		const dashboard = await client.dashboard();
		return send(res, 200, { site: safeAdminData(site), dashboard });
	}

	async function deprovision(req, res) {
		return send(res, 200, await client.deprovisionSite('manual_disconnect'));
	}

	async function ensureAdmin(req, res, next) {
		if (user?.isAdministrator && await user.isAdministrator(req.uid)) {
			return next();
		}
		return send(res, 403, new Error('[[error:no-privileges]]'));
	}

	return {
		page,
		status,
		connectionTest,
		register,
		attackStart: (req, res) => attackMode(req, res, true),
		attackEnd: (req, res) => attackMode(req, res, false),
		portal,
		synchronize,
		deprovision,
		ensureAdmin,
	};
}

module.exports = { createControllers, portalUrlIsTrusted };
