const test = require('node:test');
const assert = require('node:assert');

// O logger manda meta para o Axiom (log externo). Um erro em /api/auth/login
// levava o body inteiro — senha em texto puro — para la.
const logger = require('../../utils/logger');

test('logger existe e expoe apiError', () => {
	assert.strictEqual(typeof logger.apiError, 'function');
});

test('campos sensiveis do body nao chegam ao destino do log', () => {
	const captured = [];
	const originalError = console.error;
	console.error = (...args) => captured.push(args);
	try {
		logger.apiError(new Error('boom'), {
			method: 'POST',
			path: '/api/auth/login',
			query: { token: 'abc123' },
			body: { username: 'ricardo', password: 'SenhaSuperSecreta', nested: { apiKey: 'k-123' } },
		});
	} finally {
		console.error = originalError;
	}

	const serialized = JSON.stringify(captured);
	assert.ok(!serialized.includes('SenhaSuperSecreta'), 'senha nao pode aparecer no log');
	assert.ok(!serialized.includes('k-123'), 'apiKey aninhada nao pode aparecer');
	assert.ok(!serialized.includes('abc123'), 'token de query nao pode aparecer');
	assert.ok(serialized.includes('[REDACTED]'), 'campos sensiveis viram [REDACTED]');
	assert.ok(serialized.includes('ricardo'), 'campos nao sensiveis continuam visiveis para depurar');
});
