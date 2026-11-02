const test = require('node:test');
const assert = require('node:assert');

const { createRequester } = require('../../../../lib/competitors/niagara/requester');

const quiet = { info() {}, warn() {}, error() {} };
const err = (code, extra = {}) => Object.assign(new Error(code), { code, retryable: false, retryAfterMs: null, ...extra });

function setup(options = {}) {
	const sleeps = [];
	const requester = createRequester({
		sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, delayMs: 3000, jitterMs: 1000,
		maxAttempts: 3, backoffMs: 2000, retryAfterCapMs: 120000, challengeRetryDelayMs: 60000, logger: quiet, ...options,
	});
	return { requester, sleeps };
}

test('requests are paced: no wait before the first one, delay plus jitter before the next', async () => {
	const { requester, sleeps } = setup({ random: () => 0.5 });
	await requester.run('a', async () => 1);
	await requester.run('b', async () => 2);
	assert.deepStrictEqual(sleeps, [3500]);
	assert.deepStrictEqual(requester.stats(), { requests: 2, httpAttempts: 2, retries: 0, rateLimited: 0, challenged: 0 });
});

test('a retryable error is retried with quadratic backoff up to maxAttempts, then thrown', async () => {
	const { requester, sleeps } = setup();
	let calls = 0;
	await assert.rejects(requester.run('x', async () => { calls += 1; throw err('NIAGARA_HTTP_ERROR', { retryable: true }); }), /NIAGARA_HTTP_ERROR/);
	assert.strictEqual(calls, 3);
	assert.deepStrictEqual(sleeps, [2000, 3000, 8000, 3000]);
});

test('a 429 waits Retry-After (capped) instead of the backoff', async () => {
	const { requester, sleeps } = setup({ retryAfterCapMs: 90000 });
	let calls = 0;
	const value = await requester.run('x', async () => {
		calls += 1;
		if (calls === 1) throw err('NIAGARA_RATE_LIMITED', { retryable: true, retryAfterMs: 60000 });
		if (calls === 2) throw err('NIAGARA_RATE_LIMITED', { retryable: true, retryAfterMs: 600000 });
		return 'ok';
	});
	assert.strictEqual(value, 'ok');
	assert.deepStrictEqual(sleeps, [60000, 3000, 90000, 3000]);
	assert.strictEqual(requester.stats().rateLimited, 2);
});

test('a definitive error is not retried', async () => {
	const { requester } = setup();
	let calls = 0;
	await assert.rejects(requester.run('x', async () => { calls += 1; throw err('NIAGARA_NOT_FOUND'); }), /NIAGARA_NOT_FOUND/);
	assert.strictEqual(calls, 1);
});

test('a challenge waits once and retries once; a second challenge is thrown', async () => {
	const { requester, sleeps } = setup();
	let calls = 0;
	await assert.rejects(requester.run('x', async () => { calls += 1; throw err('NIAGARA_CHALLENGED'); }), /NIAGARA_CHALLENGED/);
	assert.strictEqual(calls, 2);
	assert.deepStrictEqual(sleeps, [60000, 3000]);
	assert.strictEqual(requester.stats().challenged, 2);
});

test('a challenge that clears on the retry returns the value', async () => {
	const { requester } = setup();
	let calls = 0;
	const value = await requester.run('x', async () => {
		calls += 1;
		if (calls === 1) throw err('NIAGARA_CHALLENGED');
		return 'json';
	});
	assert.strictEqual(value, 'json');
});
