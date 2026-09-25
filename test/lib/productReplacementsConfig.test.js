const test = require('node:test');
const assert = require('node:assert');

// config/productReplacements.js is pure (env + literals): load it fresh with
// the env of each case so the rollout list is what the test says.
const loadConfig = (allowed) => {
	const previous = process.env.REPLACEMENTS_ALLOWED_USERS;
	if (allowed === undefined) delete process.env.REPLACEMENTS_ALLOWED_USERS;
	else process.env.REPLACEMENTS_ALLOWED_USERS = allowed;
	delete require.cache[require.resolve('../../config/productReplacements')];
	const config = require('../../config/productReplacements');
	if (previous === undefined) delete process.env.REPLACEMENTS_ALLOWED_USERS;
	else process.env.REPLACEMENTS_ALLOWED_USERS = previous;
	delete require.cache[require.resolve('../../config/productReplacements')];
	return config;
};

test('a "*" in REPLACEMENTS_ALLOWED_USERS opens the feature to every logged in user', () => {
	const { isReplacementsUser, config } = loadConfig('*');
	assert.strictEqual(config.replacementsEverybody, true);
	assert.strictEqual(isReplacementsUser({ username: 'anyone', email: 'x@y' }), true);
	assert.strictEqual(isReplacementsUser('someone-else'), true);
	assert.strictEqual(isReplacementsUser(null), false, 'no user is still no user');
});

test('a plain list keeps the gate', () => {
	const { isReplacementsUser, config } = loadConfig('admin, ricardo');
	assert.strictEqual(config.replacementsEverybody, false);
	assert.strictEqual(isReplacementsUser({ username: 'ricardo' }), true);
	assert.strictEqual(isReplacementsUser({ username: 'tess', email: 'tess@x' }), false);
});

test('the default is released to everybody', () => {
	const { config } = loadConfig(undefined);
	assert.strictEqual(config.replacementsEverybody, true);
});
