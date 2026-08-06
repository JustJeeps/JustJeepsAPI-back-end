const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { userAllowlist } = require('../../config/allowlists');

test('uses the env var when it exists, normalizing whitespace and case', () => {
	process.env.TEST_ALLOWLIST = ' Ana, BRUNO  carla ';
	try {
		assert.deepStrictEqual([...userAllowlist('TEST_ALLOWLIST', 'x')], ['ana', 'bruno', 'carla']);
	} finally {
		delete process.env.TEST_ALLOWLIST;
	}
});

test('falls back to the code default when the env var is missing or empty', () => {
	assert.deepStrictEqual([...userAllowlist('NOT_DEFINED_HERE', 'tess,paula')], ['tess', 'paula']);
	process.env.TEST_ALLOWLIST_EMPTY = '';
	try {
		assert.deepStrictEqual([...userAllowlist('TEST_ALLOWLIST_EMPTY', 'tess')], ['tess']);
	} finally {
		delete process.env.TEST_ALLOWLIST_EMPTY;
	}
});

test('a genuinely empty list lets nobody through', () => {
	process.env.TEST_ALLOWLIST_NOBODY = ',,  ,';
	try {
		const allowed = userAllowlist('TEST_ALLOWLIST_NOBODY', 'tess');
		assert.strictEqual(allowed.size, 0);
		assert.strictEqual(allowed.has('tess'), false);
	} finally {
		delete process.env.TEST_ALLOWLIST_NOBODY;
	}
});

test('no server.js route keeps a literal allowlist', () => {
	const serverSource = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
	assert.ok(!/const allowed = \['/.test(serverSource), 'allowlists must come from env vars, not from a literal array');
	assert.ok(/require\('\.\/config\/allowlists'\)/.test(serverSource), 'server.js uses the allowlists module');
});
