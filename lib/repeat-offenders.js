'use strict';

const { createHash } = require('node:crypto');
const { isOn } = require('./settings');

const WINDOW_SECONDS = 24 * 60 * 60;
const BAN_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_QUEUE = 'forum-fortress:repeat-cleanup:queue';
const CLEANUP_BATCH_SIZE = 5;
const CLEANUP_LOCK_SECONDS = 5 * 60;
const MAX_BAN_MEMBER_POSTS = 10;
const MAX_CLEANUP_POSTS = 5;
const MAX_CLEANUP_MEMBER_POSTS = 5;
const MAX_MEMBER_AGE = 7 * 24 * 60 * 60 * 1000;
const REPEAT_BAN_REASON = 'Two high-confidence Forum Fortress spam blocks within 24 hours';
const CLEANUP_BAN_REASON = 'Three qualifying Forum Fortress spam blocks within 24 hours';

function decisionFingerprint(response) {
	const reference = response?.decision_reference ?? response?.decision_id;
	if (reference === undefined || reference === null || String(reference).trim() === '' || String(reference) === '0') return null;
	return createHash('sha256').update(String(reference)).digest('hex');
}

async function isProtectedMember(user, uid) {
	if (typeof user?.isAdministrator !== 'function'
		|| typeof user?.isGlobalModerator !== 'function'
		|| typeof user?.isModeratorOfAnyCategory !== 'function') return true;
	return await user.isAdministrator(uid)
		|| await user.isGlobalModerator(uid)
		|| await user.isModeratorOfAnyCategory(uid);
}

function cleanupStorageAvailable(db) {
	return ['increment', 'expire', 'delete', 'getObject', 'setObject', 'sortedSetAdd', 'sortedSetRemove', 'getSortedSetRange', 'getSortedSetRangeWithScores']
		.every(method => typeof db?.[method] === 'function');
}

function nativeCleanupAvailable({ db, cron, user, posts, topics, privileges }) {
	return cleanupStorageAvailable(db)
		&& typeof cron?.addJob === 'function'
		&& typeof user?.getUserFields === 'function'
		&& typeof user?.getPostIds === 'function'
		&& typeof user?.isAdministrator === 'function'
		&& typeof user?.bans?.ban === 'function'
		&& typeof user?.bans?.isBanned === 'function'
		&& typeof posts?.getPostData === 'function'
		&& typeof posts?.tools?.delete === 'function'
		&& typeof topics?.getTopicFields === 'function'
		&& typeof privileges?.categories?.can === 'function';
}

async function memberIsEligible(user, uid, now, maxPosts = MAX_CLEANUP_POSTS) {
	if (await isProtectedMember(user, uid)) return false;
	const profile = await user.getUserFields(uid, ['joindate', 'postcount']);
	const joined = Number(profile?.joindate || 0);
	const posts = Number(profile?.postcount);
	const joinedMillis = joined < 100000000000 ? joined * 1000 : joined;
	const age = now() - joinedMillis;
	return Boolean(joined) && Number.isFinite(posts) && posts <= maxPosts
		&& age >= 0 && age <= MAX_MEMBER_AGE;
}

async function withAccountLock(db, uid, task) {
	const key = `forum-fortress:repeat-cleanup:lock:${uid}`;
	if (Number(await db.increment(key)) !== 1) return false;
	try {
		await db.expire(key, CLEANUP_LOCK_SECONDS);
		await task();
	} finally {
		await db.delete(key);
	}
	return true;
}

async function setCleanupState(db, uid, state) {
	// NodeBB's Redis adapter stringifies hash fields, including arrays, and
	// ignores null values. Persist explicit JSON lists and an empty pending ID
	// so receipts survive a new worker and clearing intent removes old intent.
	await db.setObject(`forum-fortress:repeat-cleanup:${uid}`, {
		...state,
		cleaned_pids: JSON.stringify(state.cleaned_pids || []),
		skipped_pids: JSON.stringify(state.skipped_pids || []),
		evidence_refs: JSON.stringify(state.evidence_refs || []),
		pending_pid: state.pending_pid ? String(state.pending_pid) : '',
		ban_applied: state.ban_applied ? '1' : '0',
	});
}

function readCleanupState(state) {
	if (!state) return null;
	const list = (value) => {
		if (Array.isArray(value)) return value;
		if (!value) return [];
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
		} catch (error) {}
		// Upgrade an interrupted pre-release Redis receipt without forgetting
		// posts already cleaned. Other invalid receipts stop enforcement.
		if (/^(?:[0-9]+|[a-f0-9]{64})(?:,(?:[0-9]+|[a-f0-9]{64}))*$/.test(value)) return value.split(',');
		throw new Error('Invalid native cleanup receipt list');
	};
	return {
		...state,
		cleaned_pids: list(state.cleaned_pids),
		skipped_pids: list(state.skipped_pids),
		evidence_refs: list(state.evidence_refs),
		ban_applied: isOn(state.ban_applied),
	};
}

function bindNativeBan(state, ban, uid) {
	if (!ban || Number(ban.uid) !== uid || !Number.isSafeInteger(Number(ban.timestamp))
		|| Number(ban.timestamp) <= 0 || Number(ban.expire) <= Number(ban.timestamp)
		|| ban.reason !== CLEANUP_BAN_REASON) throw new Error('Native cleanup ban receipt is unavailable');
	state.ban_receipt_key = `uid:${uid}:ban:${ban.timestamp}`;
	state.ban_expire = Number(ban.expire);
}

async function matchesNativeBan(db, user, uid, state) {
	if (!state.ban_receipt_key || !Number(state.ban_expire)) return false;
	const [latest, ban, member] = await Promise.all([
		db.getSortedSetRange(`uid:${uid}:bans:timestamp`, -1, -1),
		db.getObject(state.ban_receipt_key),
		user.getUserFields(uid, ['banned:expire']),
	]);
	return latest?.[0] === state.ban_receipt_key && Number(ban?.uid) === uid
		&& ban?.reason === CLEANUP_BAN_REASON && Number(ban?.expire) === Number(state.ban_expire)
		&& Number(member?.['banned:expire']) === Number(state.ban_expire)
		&& await user.bans.isBanned(uid);
}

async function cancelCleanup(db, uid, state, now, reason) {
	state.phase = 'canceled';
	state.canceled_at = now();
	state.cancel_reason = reason;
	await setCleanupState(db, uid, state);
	await db.sortedSetRemove(CLEANUP_QUEUE, String(uid));
}

async function recordBlockedAttempt({
	response, uid, settings, db, user, cleanup, content = '', now = Date.now, logger = console,
}) {
	const action = settings?.repeat_offender_action;
	const cleanupMode = action === 'suspend_and_clean';
	if (!['suspend', 'suspend_and_clean'].includes(action)
		|| response?.decision !== 'block'
		|| (cleanupMode ? response?.repeat_cleanup_eligible !== true : response?.escalation_eligible !== true)) return false;
	const id = Number(uid);
	const fingerprint = decisionFingerprint(response);
	if (!Number.isSafeInteger(id) || id < 1 || !fingerprint
		|| typeof db?.increment !== 'function' || typeof db?.expire !== 'function'
		|| typeof user?.getUserFields !== 'function' || typeof user?.bans?.ban !== 'function') return false;
	if (action === 'suspend_and_clean' && !nativeCleanupAvailable({ ...cleanup, db, user })) return false;

	let enforcementKey = '';
	let banStarted = false;
	try {
		if (!isOn(settings.enabled) || !(await memberIsEligible(user, id, now,
			cleanupMode ? MAX_CLEANUP_MEMBER_POSTS : MAX_BAN_MEMBER_POSTS))) return false;
		const key = `forum-fortress:repeat-offender:${id}`;
		const modeKey = cleanupMode ? `${key}:cleanup` : key;
		const eventKey = `${modeKey}:event:${fingerprint}`;
		if (Number(await db.increment(eventKey)) !== 1) return false;
		await db.expire(eventKey, WINDOW_SECONDS);
		const body = String(content || '').trim();
		if (body) {
			const bodyFingerprint = createHash('sha256').update(body).digest('hex');
			const bodyKey = `${modeKey}:body:${bodyFingerprint}`;
			if (Number(await db.increment(bodyKey)) !== 1) return false;
			await db.expire(bodyKey, WINDOW_SECONDS);
		}
		let evidenceRefs = [];
		let count;
		if (action === 'suspend_and_clean') {
			const eventsKey = `${modeKey}:events`;
			const at = now();
			await db.sortedSetAdd(eventsKey, at, fingerprint);
			await db.expire(eventsKey, WINDOW_SECONDS);
			const rows = await db.getSortedSetRangeWithScores(eventsKey, 0, -1);
			const cutoff = at - WINDOW_SECONDS * 1000;
			const current = (rows || []).filter(row => Number(row.score) >= cutoff && Number(row.score) <= at);
			const expired = (rows || []).filter(row => Number(row.score) < cutoff || Number(row.score) > at);
			for (const row of expired) await db.sortedSetRemove(eventsKey, row.value);
			evidenceRefs = current.map(row => String(row.value));
			count = evidenceRefs.length;
		} else {
			count = Number(await db.increment(`${key}:count`));
			if (count === 1) await db.expire(`${key}:count`, WINDOW_SECONDS);
		}
		const threshold = cleanupMode ? 3 : 2;
		if (!Number.isFinite(count) || count < threshold) return false;
		if (Number(await db.increment(`${modeKey}:enforced`)) !== 1) return false;
		enforcementKey = `${modeKey}:enforced`;
		await db.expire(`${modeKey}:enforced`, WINDOW_SECONDS);

		let banApplied = false;
		const locked = await withAccountLock(db, id, async () => {
			if (settings.repeat_offender_action !== action || !isOn(settings.enabled)) return;
			if (!(await memberIsEligible(user, id, now,
				cleanupMode ? MAX_CLEANUP_MEMBER_POSTS : MAX_BAN_MEMBER_POSTS)) || await user.bans.isBanned(id)) return;
			let state;
			if (action === 'suspend_and_clean') {
				state = {
					uid: id,
					phase: 'pending_ban',
					qualified_at: now(),
					evidence_count: count,
					evidence_refs: evidenceRefs.slice(-threshold),
					cleaned_pids: [],
					skipped_pids: [],
				};
				await setCleanupState(db, id, state);
				await db.sortedSetAdd(CLEANUP_QUEUE, state.qualified_at, String(id));
			}
			banStarted = true;
			const ban = await user.bans.ban(id, now() + BAN_MILLISECONDS, cleanupMode
				? CLEANUP_BAN_REASON
				: REPEAT_BAN_REASON);
			banApplied = true;
			if (state) {
				bindNativeBan(state, ban, id);
				state.ban_applied = true;
				state.phase = 'pending_cleanup';
				await setCleanupState(db, id, state);
				await db.setObject(`forum-fortress:repeat-ban:${id}`, { applied_at: now(), evidence_count: count, cleanup_mode: true });
			}
		});
		if (!locked || !banApplied) return false;
		logger.info?.(`[forum-fortress] temporary repeat-offender ban applied to member ${id}`);
		return true;
	} catch (error) {
		// A queue/receipt failure before entering the native ban API has no
		// account side effect. Let a later independent certificate retry it.
		// Once native writes may have begun, retain the claim for review.
		if (enforcementKey && !banStarted) {
			try { await db.delete(enforcementKey); } catch (ignored) {}
		}
		// The durable pending record, if written, remains available to the worker.
		logger.warn?.(`[forum-fortress] repeat-offender enforcement deferred (${error?.constructor?.name || 'error'})`);
		return false;
	}
}

async function cleanMemberPosts({ uid, record, db, user, posts, topics, privileges, actorUid = 1, now }) {
	if (!(await memberIsEligible(user, uid, now, MAX_CLEANUP_MEMBER_POSTS)) || !await user.isAdministrator(actorUid)) return false;
	const pids = await user.getPostIds(uid, 0, MAX_CLEANUP_POSTS - 1);
	if (!Array.isArray(pids)) return false;
	const cleaned = new Set((record.cleaned_pids || []).map(String));
	const skipped = new Set((record.skipped_pids || []).map(String));

	if (record.pending_pid) {
		const pending = await posts.getPostData(record.pending_pid);
		if (pending?.deleted && String(pending.uid) === String(uid)) cleaned.add(String(record.pending_pid));
		else skipped.add(String(record.pending_pid));
		record.pending_pid = null;
		record.cleaned_pids = [...cleaned];
		record.skipped_pids = [...skipped];
		await setCleanupState(db, uid, record);
	}

	for (const rawPid of pids.slice(0, MAX_CLEANUP_POSTS)) {
		const pid = String(rawPid);
		if (cleaned.has(pid) || skipped.has(pid)) continue;
		const post = await posts.getPostData(pid);
		if (!post || String(post.uid) !== String(uid) || post.deleted) {
			skipped.add(pid);
			record.skipped_pids = [...skipped];
			await setCleanupState(db, uid, record);
			continue;
		}
		const topic = await topics.getTopicFields(post.tid, ['cid', 'mainPid', 'private', 'private_message', 'deleted']);
		if (!topic?.cid || !topic.mainPid || String(topic.mainPid) === pid || topic.private || topic.private_message || topic.deleted
			|| !await privileges.categories.can('topics:read', topic.cid, 0)) {
			skipped.add(pid);
			record.skipped_pids = [...skipped];
			await setCleanupState(db, uid, record);
			continue;
		}
		if (!(await memberIsEligible(user, uid, now, MAX_CLEANUP_MEMBER_POSTS)) || !await matchesNativeBan(db, user, uid, record)) return false;

		// NodeBB's native delete is reversible and acts on this post only.
		// Save intent first so an interrupted retry can inspect rather than repeat it.
		record.pending_pid = pid;
		await setCleanupState(db, uid, record);
		await posts.tools.delete(actorUid, pid);
		cleaned.add(pid);
		record.pending_pid = null;
		record.cleaned_pids = [...cleaned];
		await setCleanupState(db, uid, record);
	}
	return true;
}

async function processCleanupQueue({ settings, db, user, posts, topics, privileges, logger = console, now = Date.now }) {
	const ids = await db.getSortedSetRange(CLEANUP_QUEUE, 0, CLEANUP_BATCH_SIZE - 1);
	let processed = 0;
	for (const rawUid of ids || []) {
		const uid = Number(rawUid);
		if (!Number.isSafeInteger(uid) || uid < 1) {
			await db.sortedSetRemove(CLEANUP_QUEUE, String(rawUid));
			continue;
		}
		try {
			await withAccountLock(db, uid, async () => {
				const record = readCleanupState(await db.getObject(`forum-fortress:repeat-cleanup:${uid}`));
				if (!record || ['complete', 'canceled'].includes(record.phase)) {
					await db.sortedSetRemove(CLEANUP_QUEUE, String(uid));
					return;
				}
				const currentSettings = await settings();
				if (!isOn(currentSettings.enabled) || currentSettings.repeat_offender_action !== 'suspend_and_clean') {
					await cancelCleanup(db, uid, record, now, 'feature_disabled');
					return;
				}
				if (Number(record.evidence_count) < 3
					|| (!record.cleanup_started_at && now() - Number(record.qualified_at) > WINDOW_SECONDS * 1000)) {
					await cancelCleanup(db, uid, record, now, 'evidence_expired');
					return;
				}
				if (!(await memberIsEligible(user, uid, now, MAX_CLEANUP_MEMBER_POSTS))) {
					await cancelCleanup(db, uid, record, now, 'member_ineligible');
					return;
				}
				if (record.phase === 'pending_ban') {
					if (await user.bans.isBanned(uid)) {
						await cancelCleanup(db, uid, record, now, 'already_restricted');
						return;
					}
					const ban = await user.bans.ban(uid, now() + BAN_MILLISECONDS, CLEANUP_BAN_REASON);
					bindNativeBan(record, ban, uid);
					record.ban_applied = true;
					record.phase = 'pending_cleanup';
					await db.setObject(`forum-fortress:repeat-ban:${uid}`, { applied_at: now(), evidence_count: record.evidence_count });
					await setCleanupState(db, uid, record);
				}
				if (!record.ban_applied || !await matchesNativeBan(db, user, uid, record)) {
					await cancelCleanup(db, uid, record, now, 'restriction_reversed');
					return;
				}
				if (!record.cleanup_started_at) {
					record.cleanup_started_at = now();
					await setCleanupState(db, uid, record);
				}
				const done = await cleanMemberPosts({ uid, record, db, user, posts, topics, privileges, now });
				if (!done) {
					await cancelCleanup(db, uid, record, now, 'revalidation_failed');
					return;
				}
				record.phase = 'complete';
				record.completed_at = now();
				record.cleaned_count = (record.cleaned_pids || []).length;
				record.skipped_count = (record.skipped_pids || []).length;
				await setCleanupState(db, uid, record);
				await db.sortedSetRemove(CLEANUP_QUEUE, String(uid));
				processed += 1;
			});
		} catch (error) {
			logger.warn?.(`[forum-fortress] repeat-offender cleanup retry retained for member ${uid} (${error?.constructor?.name || 'error'})`);
		}
	}
	return processed;
}

module.exports = {
	CLEANUP_BATCH_SIZE,
	CLEANUP_QUEUE,
	WINDOW_SECONDS,
	cleanupStorageAvailable,
	decisionFingerprint,
	isProtectedMember,
	nativeCleanupAvailable,
	processCleanupQueue,
	recordBlockedAttempt,
};
