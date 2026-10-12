'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordBlockedAttempt } = require('../lib/repeat-offenders');
const { DEFAULT_SETTINGS } = require('../lib/settings');

function fixture({ staff = false, ageMs = 100000, postcount = 0 } = {}) {
	const counters = new Map();
	const expirations = [];
	const bans = [];
	const now = () => 1700000000000;
	const db = {
		increment: async key => {
			const next = (counters.get(key) || 0) + 1;
			counters.set(key, next);
			return next;
		},
		expire: async (key, seconds) => { expirations.push([key, seconds]); },
	};
	const user = {
		isAdministrator: async () => staff,
		isGlobalModerator: async () => false,
		isModeratorOfAnyCategory: async () => false,
		getUserFields: async () => ({ joindate: now() - ageMs, postcount }),
		bans: {
			isBanned: async () => false,
			ban: async (...args) => { bans.push(args); },
		},
	};
	const settings = { repeat_offender_action: 'suspend' };
	const base = { uid: 42, settings, db, user, now, logger: { warn() {}, info() {} } };
	const blocked = reference => ({ decision: 'block', escalation_eligible: true, correlation_id: reference });
	return { base, blocked, bans, counters, expirations, user };
}

test('the setting is off by default and legacy API responses cannot trigger a ban', async () => {
	const { base, blocked, bans } = fixture();
	assert.equal(DEFAULT_SETTINGS.repeat_offender_action, 'off');
	assert.equal(await recordBlockedAttempt({ ...base, settings: DEFAULT_SETTINGS, response: blocked('1') }), false);
	assert.equal(await recordBlockedAttempt({ ...base, response: { decision: 'block', correlation_id: '2' } }), false);
	assert.equal(await recordBlockedAttempt({ ...base, response: { decision: 'allow', escalation_eligible: true, correlation_id: '3' } }), false);
	assert.equal(await recordBlockedAttempt({ ...base, response: { decision: 'block', escalation_eligible: true } }), false);
	assert.deepEqual(bans, []);
});

test('two distinct certified blocks produce one seven-day ban and retry dedupe', async () => {
	const { base, blocked, bans, expirations } = fixture();
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('first') }), false);
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('first') }), false);
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('second') }), true);
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('third') }), false);
	assert.equal(bans.length, 1);
	assert.equal(bans[0][0], 42);
	assert.equal(bans[0][1], base.now() + 7 * 86400000);
	assert.ok(expirations.every(([, seconds]) => seconds === 86400));
});

test('staff and moderators are excluded even when explicitly enabled', async () => {
	for (const role of ['isAdministrator', 'isGlobalModerator', 'isModeratorOfAnyCategory']) {
		const { base, blocked, bans } = fixture();
		base.user[role] = async () => true;
		assert.equal(await recordBlockedAttempt({ ...base, response: blocked(role) }), false);
		assert.deepEqual(bans, []);
	}
});

test('established users and invalid account data fail safe', async () => {
	for (const data of [{ ageMs: 8 * 86400000 }, { postcount: 11 }, { ageMs: -1000 }]) {
		const { base, blocked } = fixture(data);
		assert.equal(await recordBlockedAttempt({ ...base, response: blocked(String(data.ageMs ?? data.postcount)) }), false);
	}
	const { base, blocked } = fixture();
	assert.equal(await recordBlockedAttempt({ ...base, uid: 0, response: blocked('guest') }), false);
	base.user.getUserFields = async () => ({ postcount: 1 });
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('unknown join') }), false);
});

test('counter/permissions failure never causes a ban', async () => {
	const { base, blocked, bans } = fixture();
	base.db.increment = async () => { throw new Error('database unavailable'); };
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('a') }), false);
	assert.deepEqual(bans, []);
	base.user.isModeratorOfAnyCategory = undefined;
	assert.equal(await recordBlockedAttempt({ ...base, response: blocked('b') }), false);
	assert.deepEqual(bans, []);
});
