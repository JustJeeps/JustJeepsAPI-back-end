const test = require('node:test');
const assert = require('node:assert');

// The allowlist is resolved at require time, so each scenario loads the module fresh.
const loadTriage = (env) => {
	const previous = { ...process.env };
	Object.assign(process.env, env);
	delete require.cache[require.resolve('../../config/triage')];
	const mod = require('../../config/triage');
	process.env = previous;
	delete require.cache[require.resolve('../../config/triage')];
	return mod;
};

test('allowlist comes from FEEDS_TRIAGE_USERS with a fallback to REQUESTS_TRIAGE_USERS', () => {
	assert.deepStrictEqual(loadTriage({ FEEDS_TRIAGE_USERS: 'ana, bruno' }).config.triageUsers, ['ana', 'bruno']);
	assert.deepStrictEqual(
		loadTriage({ FEEDS_TRIAGE_USERS: '', REQUESTS_TRIAGE_USERS: 'carla' }).config.triageUsers,
		['carla']
	);
});

test('comparison is case-insensitive on both sides', () => {
	const { isTriageUser } = loadTriage({ FEEDS_TRIAGE_USERS: 'Ricardo,RAFAEL' });
	assert.strictEqual(isTriageUser('ricardo'), true);
	assert.strictEqual(isTriageUser('RaFaEl'), true);
	assert.strictEqual(isTriageUser('rafael '), false, 'whitespace is not normalized in the lookup: the username comes from the database already trimmed');
});

test('anyone outside the list never passes, including odd values', () => {
	const { isTriageUser } = loadTriage({ FEEDS_TRIAGE_USERS: 'ricardo' });
	for (const value of ['', null, undefined, 'ricard', 'ricardo2', 'ricardo,rafael', 0, {}, []]) {
		assert.strictEqual(isTriageUser(value), false, `should reject: ${JSON.stringify(value)}`);
	}
});
