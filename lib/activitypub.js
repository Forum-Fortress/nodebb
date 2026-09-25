'use strict';

function isRemoteIdentifier(value) {
	if (typeof value !== 'string') {
		return false;
	}
	try {
		const parsed = new URL(value);
		return ['http:', 'https:', 'acct:'].includes(parsed.protocol);
	} catch (error) {
		return false;
	}
}

function isRemoteEvent(event = {}) {
	const post = event.post || {};
	const data = event.data || {};
	if (event._activitypub || post._activitypub || data._activitypub || data.activitypub) {
		return true;
	}

	return [
		event.uid,
		post.uid,
		post.pid,
		post.tid,
		post.toPid,
		data.uid,
		data.pid,
		data.tid,
		data.toPid,
	].some(isRemoteIdentifier);
}

module.exports = { isRemoteEvent, isRemoteIdentifier };
