'use strict';

class UnavailableError extends Error {
	constructor(message = '[[forum-fortress:unavailable]]', cause) {
		super(message);
		this.name = 'UnavailableError';
		this.cause = cause;
	}
}

function assertAllowed(response) {
	if (response === null || response === undefined) {
		return;
	}
	const decision = String(response.decision || '').trim().toLowerCase();
	if (decision === 'allow' || decision === 'review') {
		return;
	}
	if (decision === 'block') {
		throw new Error('[[forum-fortress:blocked]]');
	}
	throw new UnavailableError('[[forum-fortress:unavailable]]');
}

module.exports = { UnavailableError, assertAllowed };
