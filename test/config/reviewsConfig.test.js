const test = require('node:test');
const assert = require('node:assert');

// Config resolvida no require (padrao dos config/*.js): cada cenario recarrega
// o modulo com o env desejado (molde test/config/triage.test.js).
function loadConfig(env = {}) {
	const saved = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		process.env[key] = env[key];
	}
	delete require.cache[require.resolve('../../config/reviews.js')];
	try {
		return require('../../config/reviews.js');
	} finally {
		for (const key of Object.keys(env)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		delete require.cache[require.resolve('../../config/reviews.js')];
	}
}

test('allowlist default: ricardo, admin, rafael e tess', () => {
	const { isReviewsUser } = loadConfig();
	for (const username of ['ricardo', 'admin', 'rafael', 'tess']) {
		assert.strictEqual(isReviewsUser(username), true, username);
	}
	assert.strictEqual(isReviewsUser('jerry'), false);
});

test('isReviewsUser normaliza caixa e espacos dos dois lados', () => {
	const { isReviewsUser } = loadConfig({ REVIEWS_ALLOWED_USERS: ' Rafael, TESS ' });
	assert.strictEqual(isReviewsUser('rafael'), true);
	assert.strictEqual(isReviewsUser('Rafael '), true);
	assert.strictEqual(isReviewsUser('ricardo'), false);
	assert.strictEqual(isReviewsUser(null), false);
	assert.strictEqual(isReviewsUser(undefined), false);
});

test('batchSize: default 50, clamp 1..100, invalido cai no default', () => {
	assert.strictEqual(loadConfig().config.batchSize, 50);
	assert.strictEqual(loadConfig({ REVIEWS_SYNC_BATCH_SIZE: '500' }).config.batchSize, 100);
	assert.strictEqual(loadConfig({ REVIEWS_SYNC_BATCH_SIZE: '0' }).config.batchSize, 1);
	assert.strictEqual(loadConfig({ REVIEWS_SYNC_BATCH_SIZE: 'abc' }).config.batchSize, 50);
});

test('batchDelayMs: default 1000, nunca abaixo de 500 (protecao do site)', () => {
	assert.strictEqual(loadConfig().config.batchDelayMs, 1000);
	assert.strictEqual(loadConfig({ REVIEWS_SYNC_BATCH_DELAY_MS: '0' }).config.batchDelayMs, 500);
	assert.strictEqual(loadConfig({ REVIEWS_SYNC_BATCH_DELAY_MS: '5000' }).config.batchDelayMs, 5000);
});

test('limites de upload e de linhas tem defaults sensatos', () => {
	const { config } = loadConfig();
	assert.strictEqual(config.maxUploadBytes, 10 * 1024 * 1024);
	assert.strictEqual(config.maxRows, 60000);
	assert.strictEqual(config.insertChunkSize, 1000);
});

test('tipos aceitos: só planilha (.xlsx/.csv) com os mimetypes do molde de anexos', () => {
	const { REVIEWS_ALLOWED_TYPES } = loadConfig();
	assert.deepStrictEqual(Object.keys(REVIEWS_ALLOWED_TYPES).sort(), ['.csv', '.xlsx']);
	assert.ok(REVIEWS_ALLOWED_TYPES['.csv'].includes('application/vnd.ms-excel'));
	assert.ok(REVIEWS_ALLOWED_TYPES['.xlsx'].includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
});
