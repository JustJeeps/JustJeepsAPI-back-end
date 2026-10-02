const test = require('node:test');
const assert = require('node:assert');

const { checkTdotRun, DEFAULT_THRESHOLDS } = require('../../../../lib/competitors/tdot/canaries');

const good = { requests: 100, failedRequests: 2, matched: 500, rawCount: 1000, invalidCount: 5 };

test('a healthy run passes', () => {
	const check = checkTdotRun(good, { minMatched: 200 });
	assert.deepStrictEqual(check, { ok: true, failures: [], stats: { requests: 100, failedRequests: 2, matched: 500, rawCount: 1000, invalidCount: 5 } });
});

test('too many failed requests, too few matches or too many invalid prices abort with a code each', () => {
	const check = checkTdotRun({ requests: 100, failedRequests: 30, matched: 10, rawCount: 1000, invalidCount: 100 }, { minMatched: 200 });
	assert.strictEqual(check.ok, false);
	assert.deepStrictEqual(check.failures.map((f) => f.code), ['REQUEST_FAILED_RATIO', 'BELOW_MIN_MATCHED', 'PRICE_INVALID_RATIO']);
	assert.match(check.failures[0].message, /30 of 100/);
});

test('defaults match the config defaults and a run with zero requests fails on matches, not on a division by zero', () => {
	assert.deepStrictEqual(DEFAULT_THRESHOLDS, { minMatched: 200, maxFailedRequestRatio: 0.1, maxInvalidRatio: 0.02 });
	const check = checkTdotRun({ requests: 0, failedRequests: 0, matched: 0, rawCount: 0, invalidCount: 0 });
	assert.deepStrictEqual(check.failures.map((f) => f.code), ['BELOW_MIN_MATCHED']);
});
