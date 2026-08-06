const test = require('node:test');
const assert = require('node:assert');

// The logger sends meta to Axiom (an external log). An error on /api/auth/login
// used to carry the whole body over there, plain text password included.
const logger = require('../../utils/logger');

test('the logger exists and exposes apiError', () => {
	assert.strictEqual(typeof logger.apiError, 'function');
});

test('sensitive body fields do not reach the log destination', () => {
	const captured = [];
	const originalError = console.error;
	console.error = (...args) => captured.push(args);
	try {
		logger.apiError(new Error('boom'), {
			method: 'POST',
			path: '/api/auth/login',
			query: { token: 'abc123' },
			body: { username: 'ricardo', password: 'SuperSecretPassword', nested: { apiKey: 'k-123' } },
		});
	} finally {
		console.error = originalError;
	}

	const serialized = JSON.stringify(captured);
	assert.ok(!serialized.includes('SuperSecretPassword'), 'the password must not appear in the log');
	assert.ok(!serialized.includes('k-123'), 'the nested apiKey must not appear');
	assert.ok(!serialized.includes('abc123'), 'the query token must not appear');
	assert.ok(serialized.includes('[REDACTED]'), 'sensitive fields become [REDACTED]');
	assert.ok(serialized.includes('ricardo'), 'non sensitive fields stay visible for debugging');
});
