const test = require('node:test');
const assert = require('node:assert');

// A allowlist e resolvida no require, entao cada cenario carrega o modulo limpo.
const loadTriage = (env) => {
	const previous = { ...process.env };
	Object.assign(process.env, env);
	delete require.cache[require.resolve('../../config/triage')];
	const mod = require('../../config/triage');
	process.env = previous;
	delete require.cache[require.resolve('../../config/triage')];
	return mod;
};

test('allowlist vem de FEEDS_TRIAGE_USERS com fallback para REQUESTS_TRIAGE_USERS', () => {
	assert.deepStrictEqual(loadTriage({ FEEDS_TRIAGE_USERS: 'ana, bruno' }).config.triageUsers, ['ana', 'bruno']);
	assert.deepStrictEqual(
		loadTriage({ FEEDS_TRIAGE_USERS: '', REQUESTS_TRIAGE_USERS: 'carla' }).config.triageUsers,
		['carla']
	);
});

test('comparacao e case-insensitive nos dois lados', () => {
	const { isTriageUser } = loadTriage({ FEEDS_TRIAGE_USERS: 'Ricardo,RAFAEL' });
	assert.strictEqual(isTriageUser('ricardo'), true);
	assert.strictEqual(isTriageUser('RaFaEl'), true);
	assert.strictEqual(isTriageUser('rafael '), false, 'espaco nao e normalizado no lookup: username vem do banco ja limpo');
});

test('quem nao esta na lista nunca passa, inclusive valores estranhos', () => {
	const { isTriageUser } = loadTriage({ FEEDS_TRIAGE_USERS: 'ricardo' });
	for (const value of ['', null, undefined, 'ricard', 'ricardo2', 'ricardo,rafael', 0, {}, []]) {
		assert.strictEqual(isTriageUser(value), false, `deveria recusar: ${JSON.stringify(value)}`);
	}
});
