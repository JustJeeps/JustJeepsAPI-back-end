const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { userAllowlist } = require('../../config/allowlists');

test('usa a env quando ela existe, normalizando espacos e maiusculas', () => {
	process.env.TEST_ALLOWLIST = ' Ana, BRUNO  carla ';
	try {
		assert.deepStrictEqual([...userAllowlist('TEST_ALLOWLIST', 'x')], ['ana', 'bruno', 'carla']);
	} finally {
		delete process.env.TEST_ALLOWLIST;
	}
});

test('cai no default do codigo quando a env nao esta definida ou esta vazia', () => {
	assert.deepStrictEqual([...userAllowlist('NAO_DEFINIDA_AQUI', 'tess,paula')], ['tess', 'paula']);
	process.env.TEST_ALLOWLIST_VAZIA = '';
	try {
		assert.deepStrictEqual([...userAllowlist('TEST_ALLOWLIST_VAZIA', 'tess')], ['tess']);
	} finally {
		delete process.env.TEST_ALLOWLIST_VAZIA;
	}
});

test('lista vazia de verdade nao libera ninguem', () => {
	process.env.TEST_ALLOWLIST_NINGUEM = ',,  ,';
	try {
		const allowed = userAllowlist('TEST_ALLOWLIST_NINGUEM', 'tess');
		assert.strictEqual(allowed.size, 0);
		assert.strictEqual(allowed.has('tess'), false);
	} finally {
		delete process.env.TEST_ALLOWLIST_NINGUEM;
	}
});

test('nenhuma rota do server.js mantem allowlist literal', () => {
	const serverSource = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
	assert.ok(!/const allowed = \['/.test(serverSource), 'allowlists devem vir de env, nao de array literal');
	assert.ok(/require\('\.\/config\/allowlists'\)/.test(serverSource), 'server.js usa o modulo de allowlists');
});
