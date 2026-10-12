'use strict';

const { createHash } = require('node:crypto');

const WINDOW_SECONDS = 24 * 60 * 60;
const BAN_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function decisionFingerprint(response) {
	const reference = response?.decision_reference ?? response?.correlation_id ?? response?.decision_id;
	if (reference === undefined || reference === null || String(reference).trim() === '' || String(reference) === '0') {
		return null;
	}
	return createHash('sha256').update(String(reference)).digest('hex');
}

async function isProtectedMember(user, uid) {
	// Missing privileges API is an exemption, not permission to moderate.
	if (typeof user?.isAdministrator !== 'function'
		|| typeof user?.isGlobalModerator !== 'function'
		|| typeof user?.isModeratorOfAnyCategory !== 'function') return true;
	return await user.isAdministrator(uid)
		|| await user.isGlobalModerator(uid)
		|| await user.isModeratorOfAnyCategory(uid);
}

/**
 * Count only independent server-certified BLOCKs for a known local member.
 * Stored locally, with atomic per-event and per-account counters.
 * No action can be triggered by an older edge response or a failed check.
 *
 * First release intentionally supports only reversible temporary bans.
 */
async function recordBlockedAttempt({ response, uid, settings, db, user, now = Date.now, logger = console }) {
	if (settings?.repeat_offender_action !== 'suspend'
		|| response?.decision !== 'block'
		|| response?.escalation_eligible !== true) return false;
	const id = Number(uid);
	const fingerprint = decisionFingerprint(response);
	if (!Number.isSafeInteger(id) || id < 1 || !fingerprint
		|| typeof db?.increment !== 'function'
		|| typeof db?.expire !== 'function'
		|| typeof user?.getUserFields !== 'function'
		|| typeof user?.bans?.ban !== 'function') return false;

	try {
		if (await isProtectedMember(user, id)) return false;
		const profile = await user.getUserFields(id, ['joindate', 'postcount']);
		const joined = Number(profile?.joindate || 0);
		const posts = Number(profile?.postcount);
		const joinedMillis = joined < 100000000000 ? joined * 1000 : joined;
		const age = now() - joinedMillis;
		if (!joined || !Number.isFinite(posts) || posts > 10
			|| age < 0 || age > 7 * 24 * 60 * 60 * 1000) return false;

		const key = `forum-fortress:repeat-offender:${id}`;
		const eventKey = `${key}:event:${fingerprint}`;
		if (Number(await db.increment(eventKey)) !== 1) return false;
		await db.expire(eventKey, WINDOW_SECONDS);
		const count = Number(await db.increment(`${key}:count`));
		if (count === 1) await db.expire(`${key}:count`, WINDOW_SECONDS);
		if (!Number.isFinite(count) || count < 2) return false;
		if (Number(await db.increment(`${key}:enforced`)) !== 1) return false;
		await db.expire(`${key}:enforced`, WINDOW_SECONDS);

		// Recheck staff status immediately before the platform mutation.
		if (await isProtectedMember(user, id)) return false;
		if (typeof user.bans.isBanned === 'function' && await user.bans.isBanned(id)) return false;
		await user.bans.ban(id, now() + BAN_MILLISECONDS, 'Two high-confidence Forum Fortress spam blocks within 24 hours');
		logger.info?.(`[forum-fortress] temporary repeat-offender ban applied to member ${id}`);
		return true;
	} catch (error) {
		logger.warn?.(`[forum-fortress] repeat-offender enforcement skipped: ${error.message}`);
		return false;
	}
}

module.exports = { decisionFingerprint, recordBlockedAttempt };
