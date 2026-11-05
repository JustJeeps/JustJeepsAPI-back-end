const test = require('node:test');
const assert = require('node:assert');

const { checkCollection, checkMatch } = require('../../../../lib/competitors/niagara/canaries');

const thresholds = { minItems: 1000, minMatched: 200, maxFailedRequestRatio: 0.1, maxBrandsFailedRatio: 0.2, maxInvalidRatio: 0.02, matchDropRatio: 0.8 };
const healthy = { requests: 170, failedRequests: 2, brandsPlanned: 120, brandsFailed: 3, rawVariants: 30000, invalidCount: 20, items: 29000 };
const codes = (r) => r.failures.map((f) => f.code);

test('a healthy collection passes', () => {
	assert.deepStrictEqual(checkCollection(healthy, thresholds), { ok: true, failures: [] });
});

test('too many failed requests, failed brands or broken prices fail the collection', () => {
	const result = checkCollection({ ...healthy, failedRequests: 30, brandsFailed: 40, invalidCount: 900 }, thresholds);
	assert.deepStrictEqual(codes(result), ['REQUEST_FAILED_RATIO', 'BRANDS_FAILED_RATIO', 'PRICE_INVALID_RATIO']);
	assert.strictEqual(result.ok, false);
});

test('too few items fails a full run, but not a sample run', () => {
	assert.deepStrictEqual(codes(checkCollection({ ...healthy, items: 900 }, thresholds)), ['BELOW_MIN_ITEMS']);
	assert.strictEqual(checkCollection({ ...healthy, items: 900 }, thresholds, { sample: true }).ok, true);
});

test('checkMatch fails below the matched floor on a full run only', () => {
	assert.deepStrictEqual(codes(checkMatch({ matched: 150, baselineRows: null }, thresholds)), ['BELOW_MIN_MATCHED']);
	assert.strictEqual(checkMatch({ matched: 150, baselineRows: null }, thresholds, { sample: true }).ok, true);
});

test('checkMatch fails when a full run matches under the ratio of the last full run', () => {
	assert.deepStrictEqual(codes(checkMatch({ matched: 7000, baselineRows: 10000 }, thresholds)), ['MATCH_DROP']);
	// A sample covers a few brands or pages, so comparing it with a full run
	// would refuse every sample once a baseline exists.
	assert.strictEqual(checkMatch({ matched: 300, baselineRows: 10000 }, thresholds, { sample: true }).ok, true);
	assert.strictEqual(checkMatch({ matched: 8000, baselineRows: 10000 }, thresholds).ok, true);
	assert.strictEqual(checkMatch({ matched: 300, baselineRows: 0 }, thresholds).ok, true);
});
