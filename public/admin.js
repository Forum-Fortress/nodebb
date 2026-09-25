'use strict';

define('admin/plugins/forum-fortress', ['settings', 'api', 'translator'], function (Settings, api, translator) {
	const selector = '.forum-fortress-admin';
	let actionInFlight = false;

	async function text(key) {
		return translator.translateKey(`[[forum-fortress:${key}]]`);
	}

	async function localize(value) {
		if (typeof value !== 'string' || !value.startsWith('[[')) return value;
		return translator.translateKey(value);
	}

	async function showMessage(message, type = 'success') {
		const element = document.querySelector(`${selector} [data-ff-message]`);
		if (!element) return;
		const noticeType = type === 'danger' ? 'error' : type;
		const icon = element.querySelector('[data-ff-message-icon]');
		const textElement = element.querySelector('[data-ff-message-text]');
		element.className = `ForumFortressNotice is-${noticeType}`;
		if (icon) {
			icon.className = `fa ${noticeType === 'error' ? 'fa-exclamation-circle' : noticeType === 'warning' ? 'fa-exclamation-triangle' : 'fa-check-circle'}`;
		}
		if (textElement) textElement.textContent = await localize(message);
	}

	function value(source, paths, fallback = '—') {
		for (const path of paths) {
			let current = source;
			for (const part of path.split('.')) current = current?.[part];
			if (current !== undefined && current !== null && current !== '') return current;
		}
		return fallback;
	}

	async function renderDashboard(dashboard) {
		const root = document.querySelector(selector);
		if (!root) return;
		const status = dashboard?.status || {};
		const stats = dashboard?.stats || {};
		const endpoint = value(dashboard, ['endpoints.last_responded', 'endpoints.preferred', 'status.preferred_endpoint']);
		const reportedStatus = String(status.status || '').toLowerCase();
		const connected = Boolean(
			!dashboard?.disabled
			&& !dashboard?.stale
			&& typeof status.site_id === 'string' && status.site_id
			&& typeof status.mode === 'string' && status.mode
			&& typeof status.plan === 'string' && status.plan
			&& typeof status.attack_mode?.enabled === 'boolean'
			&& !['disconnected', 'unavailable'].includes(reportedStatus)
		);
		const [connectedText, disconnectedText, staleText, activeText, unavailableText, allowedText, blockedText] = await Promise.all([
			text('dashboard.connected'),
			text('dashboard.disconnected'),
			text('dashboard.stale'),
			text('dashboard.active'),
			text('dashboard.not_available'),
			text('dashboard.allowed'),
			text('dashboard.blocked'),
		]);
		const statusElement = root.querySelector('[data-ff-status]');
		if (statusElement) {
			statusElement.textContent = dashboard?.stale ? staleText : (connected ? connectedText : disconnectedText);
			statusElement.className = `ForumFortressPill ${connected ? 'is-connected' : 'is-disconnected'}`;
		}
		const attackModeActive = Boolean(status.attack_mode_active || status.attack_mode?.enabled);
		root.querySelector('[data-ff-action="attack-start"]')?.classList.toggle('d-none', attackModeActive);
		root.querySelector('[data-ff-action="attack-end"]')?.classList.toggle('d-none', !attackModeActive);
		root.querySelector('[data-ff-field="protection"]')?.parentElement?.classList.toggle('is-good', connected);
		const fields = {
			protection: connected ? activeText : unavailableText,
			plan: value(dashboard, ['status.plan', 'endpoints.plan'], unavailableText),
			site_id: value(dashboard, ['status.site_id'], unavailableText),
			endpoint,
			checks: value(stats, ['current_month_checks', 'checks_this_month', 'checks'], unavailableText),
			decisions: `${value(stats, ['allows', 'allowed'], unavailableText)} ${allowedText} / ${value(stats, ['blocks', 'blocked'], unavailableText)} ${blockedText}`,
		};
		Object.entries(fields).forEach(([name, fieldValue]) => {
			const element = root.querySelector(`[data-ff-field="${name}"]`);
			if (element) element.textContent = String(fieldValue);
		});
	}

	async function request(path, body = {}) {
		try {
			const result = path === 'status'
				? await api.get('/plugins/forum-fortress/status', {})
				: await api.post(`/plugins/forum-fortress/${path}`, body);
			return result;
		} catch (error) {
			const message = error?.message || await text('errors.request_failed');
			await showMessage(message, 'danger');
			throw error;
		}
	}

	async function refresh() {
		const result = await request('status');
		await renderDashboard(result);
	}

	async function action(actionName) {
		if (actionName === 'refresh') {
			await refresh();
			await showMessage(await text('messages.refresh'), 'success');
			return;
		}
		const paths = {
			test: 'test',
			register: 'register',
			portal: 'portal',
			'sync': 'sync',
			'attack-start': 'attack-mode',
			'attack-end': 'attack-mode/end',
			deprovision: 'deprovision',
		};
		if (actionName === 'deprovision' && !window.confirm(await text('maintenance.confirm'))) return;
		const result = await request(paths[actionName]);
		if (actionName === 'portal') {
			const opened = window.open(result.portal_url, '_blank', 'noopener');
			if (!opened) await showMessage(await text('errors.popup_blocked'), 'warning');
		} else if (actionName === 'sync') {
			await renderDashboard(result.dashboard);
		} else if (actionName === 'test') {
			await renderDashboard({ status: result.status, stats: result.stats, endpoints: { last_responded: result.endpoint } });
		} else if (actionName === 'deprovision') {
			await renderDashboard({ status: { status: 'disconnected' }, stats: {} });
			await showMessage(await text('messages.disconnected'), 'success');
		} else {
			await refresh();
		}
		if (actionName !== 'deprovision') await showMessage(await text(`messages.${actionName}`), 'success');
	}

	function setActionBusy(isBusy) {
		document.querySelectorAll(`${selector} [data-ff-action]`).forEach((button) => {
			button.disabled = isBusy;
			button.setAttribute('aria-busy', String(isBusy));
		});
	}

	function runAction(button) {
		if (actionInFlight) return;
		actionInFlight = true;
		setActionBusy(true);
		action(button.getAttribute('data-ff-action'))
			.catch(() => undefined)
			.finally(() => {
				actionInFlight = false;
				setActionBusy(false);
			});
	}

	function init() {
		const form = document.querySelector(`${selector} .forum-fortress-settings`);
		if (!form) return;
		Settings.load('forum-fortress', $(form));
		document.querySelector(`${selector} #save`)?.addEventListener('click', () => {
			Promise.resolve(Settings.save('forum-fortress', $(form))).catch(async () => {
				await showMessage(await text('errors.request_failed'), 'danger');
			});
		});
		document.querySelector(`${selector} [data-ff-dismiss]`)?.addEventListener('click', () => {
			document.querySelector(`${selector} [data-ff-message]`)?.classList.add('d-none');
		});
		document.querySelectorAll(`${selector} [data-ff-action]`).forEach((button) => {
			button.addEventListener('click', () => runAction(button));
		});
		refresh().catch(() => undefined);
	}

	return { init };
});
