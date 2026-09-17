const test = require('node:test');
const assert = require('node:assert');

const { checkCollection, checkStaleFloor, DEFAULT_THRESHOLDS } = require('../../../lib/competitors/lowriders/canaries');

const rc = (n, brand = 'Rough Country') => Array.from({ length: n }, (_, i) => ({ competitorSku: `P${i}`, brandName: brand, effectivePrice: 10 }));
const small = { minItems: 10, minCollectRatio: 0.9, maxBrandImpurityRatio: 0.005, maxInvalidRatio: 0.02, maxDuplicateRatio: 0.01 };
const codes = (r) => r.failures.map((f) => f.code);

// A scraper that returns 12 products instead of 7,747 must not write anything.
test('a healthy collection passes every check', () => {
	const r = checkCollection({ items: rc(100), reportedTotal: 100, invalidCount: 0, duplicateCount: 0, thresholds: small });
	assert.deepStrictEqual(r, { ok: true, failures: [], stats: { collected: 100, reportedTotal: 100, invalidCount: 0, duplicateCount: 0, impure: 0 } });
});

test('TOTAL_MISMATCH fires just under 90% of the reported total and not at 90%', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(89), reportedTotal: 100, thresholds: small })), ['TOTAL_MISMATCH']);
	assert.deepStrictEqual(codes(checkCollection({ items: rc(90), reportedTotal: 100, thresholds: small })), []);
});

test('BELOW_MIN_ITEMS guards against a wrong reported total', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(9), reportedTotal: 9, thresholds: small })), ['BELOW_MIN_ITEMS']);
});

test('BRAND_IMPURE fires above 0.5% foreign items and lists a sample', () => {
	const items = [...rc(199), ...rc(1, 'Other')];
	const r = checkCollection({ items, reportedTotal: 200, thresholds: small });
	assert.deepStrictEqual(codes(r), []);
	const r2 = checkCollection({ items: [...rc(198), ...rc(2, 'Other')], reportedTotal: 200, thresholds: small });
	assert.deepStrictEqual(codes(r2), ['BRAND_IMPURE']);
	assert.strictEqual(r2.failures[0].detail.sample.length, 2);
});

test('PRICE_INVALID_RATIO and DUPLICATE_STOCKIDS use the raw item count', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(97), reportedTotal: 100, invalidCount: 3, thresholds: small })), ['PRICE_INVALID_RATIO']);
	assert.deepStrictEqual(codes(checkCollection({ items: rc(98), reportedTotal: 100, duplicateCount: 2, thresholds: small })), ['DUPLICATE_STOCKIDS']);
});

test('several failures are reported together', () => {
	const r = checkCollection({ items: rc(5, 'Other'), reportedTotal: 100, thresholds: small });
	assert.deepStrictEqual(codes(r).sort(), ['BELOW_MIN_ITEMS', 'BRAND_IMPURE', 'TOTAL_MISMATCH']);
});

test('stale floor needs a minimum and no big drop versus the previous run', () => {
	assert.deepStrictEqual(checkStaleFloor({ matched: 499, previousMatched: null, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, false);
	assert.deepStrictEqual(checkStaleFloor({ matched: 500, previousMatched: null, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }), { ok: true, reason: null });
	assert.strictEqual(checkStaleFloor({ matched: 799, previousMatched: 1000, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, false);
	assert.strictEqual(checkStaleFloor({ matched: 800, previousMatched: 1000, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, true);
});

test('defaults match the spec', () => {
	assert.strictEqual(DEFAULT_THRESHOLDS.minCollectRatio, 0.9);
	assert.strictEqual(DEFAULT_THRESHOLDS.minItems, 5000);
	assert.strictEqual(DEFAULT_THRESHOLDS.minMatched, 500);
	assert.strictEqual(DEFAULT_THRESHOLDS.matchDropRatio, 0.8);
});
