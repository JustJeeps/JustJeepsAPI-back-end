const test = require('node:test');
const assert = require('node:assert');

const { snapshotFileName, validateSnapshot } = require('../../../../lib/competitors/niagara/snapshot');
const { buildReportCsv } = require('../../../../lib/competitors/niagara/report');

const stamp = '2026-11-02T23-00-00-000Z';
const goodItem = { jjPrefix: 'BIL', competitorSku: 'BIL-1', price: 10, url: 'https://niagarajeeps.ca/products/x' };

test('snapshotFileName tells real, dry, sample and collect-only runs apart', () => {
	assert.strictEqual(snapshotFileName({ runId: 12, stamp }), `niagara-run-12-${stamp}.json`);
	assert.strictEqual(snapshotFileName({ runId: 12, dryRun: true, sample: true, stamp }), `niagara-run-12-dry-run-sample-${stamp}.json`);
	assert.strictEqual(snapshotFileName({ runId: null, stamp }), `niagara-collect-${stamp}.json`);
});

const now = () => new Date('2026-11-05T12:00:00Z');
const healthyCollection = { requests: 10, failedRequests: 0, brandsPlanned: 2, brandsFailed: 0, rawVariants: 10, invalidCount: 0, items: 5000 };
const thresholds = { minItems: 1000, minMatched: 1, maxFailedRequestRatio: 0.1, maxBrandsFailedRatio: 0.2, maxInvalidRatio: 0.02, matchDropRatio: 0.8 };
const rules = { now, maxAgeHours: 72, maxPrice: 20000, thresholds };
const snap = (extra = {}) => ({ schemaVersion: 1, source: 'niagara', capturedAt: '2026-11-05T10:00:00Z', items: [goodItem], collection: healthyCollection, ...extra });

test('validateSnapshot accepts a fresh, healthy payload v1 from niagara', () => {
	const payload = snap();
	assert.strictEqual(validateSnapshot(payload, rules), payload);
});

test('validateSnapshot refuses another source, another version or broken items', () => {
	assert.throws(() => validateSnapshot({ schemaVersion: 1, source: 'tdot', items: [] }, rules), /NIAGARA_BAD_SNAPSHOT/);
	assert.throws(() => validateSnapshot(snap({ schemaVersion: 2 }), rules), /schemaVersion/);
	assert.throws(() => validateSnapshot(snap({ items: [{ ...goodItem, price: 0 }] }), rules), /item 0/);
	assert.throws(() => validateSnapshot(snap({ items: [{ ...goodItem, url: 'javascript:x' }] }), rules), /item 0/);
	assert.throws(() => validateSnapshot(null, rules), /NIAGARA_BAD_SNAPSHOT/);
});

// A replay overwrites live prices and a full one becomes the match baseline,
// so it gets the same checks a live collect would have passed.
test('validateSnapshot refuses an old, undated or future snapshot', () => {
	assert.throws(() => validateSnapshot(snap({ capturedAt: '2026-11-01T10:00:00Z' }), rules), /older than 72 hours/);
	assert.throws(() => validateSnapshot(snap({ capturedAt: undefined }), rules), /capturedAt/);
	assert.throws(() => validateSnapshot(snap({ capturedAt: '2026-11-06T10:00:00Z' }), rules), /in the future/);
});

test('validateSnapshot refuses prices over the cap, sku spellings the collector never writes and duplicates', () => {
	assert.throws(() => validateSnapshot(snap({ items: [{ ...goodItem, price: 999999 }] }), rules), /item 0/);
	assert.throws(() => validateSnapshot(snap({ items: [{ ...goodItem, competitorSku: 'bil-1 ' }] }), rules), /item 0/);
	assert.throws(() => validateSnapshot(snap({ items: [goodItem, { ...goodItem, price: 11 }] }), rules), /duplicate BIL BIL-1/);
});

test('validateSnapshot reruns the collection guards, with the sample floors relaxed for a sample', () => {
	assert.throws(() => validateSnapshot(snap({ collection: undefined }), rules), /no collection stats/);
	assert.throws(() => validateSnapshot(snap({ collection: { ...healthyCollection, items: 10 } }), rules), /BELOW_MIN_ITEMS/);
	assert.doesNotThrow(() => validateSnapshot(snap({ sample: { brands: ['BIL'] }, collection: { ...healthyCollection, items: 10 } }), rules));
	assert.throws(() => validateSnapshot(snap({ collection: { ...healthyCollection, brandsFailed: 2 } }), rules), /BRANDS_FAILED_RATIO/);
});

test('buildReportCsv lists unmatched, collisions and ambiguous rows', () => {
	const csv = buildReportCsv({
		unmatched: [{ jjPrefix: 'BIL', competitorSku: 'BIL-9', url: 'https://niagarajeeps.ca/products/a' }],
		collisions: [{ competitorSku: '24 1', productSku: 'BIL-24-1', keptSku: 'BIL-24-1' }, { competitorSku: '77', productSku: 'RC-77', keptSku: '', reason: 'same-sku-in-two-brands' }],
		ambiguous: [{ competitorSku: 'X1', chosen: 'RR-X1', candidates: ['RR-X1', 'RR-X-1'] }],
	});
	assert.strictEqual(csv, [
		'list,jj_prefix,competitor_sku,product_sku,detail,url',
		'unmatched,BIL,BIL-9,,,https://niagarajeeps.ca/products/a',
		'collision,,24 1,BIL-24-1,kept BIL-24-1,',
		'collision,,77,RC-77,same sku matched in two brands: not written,',
		'ambiguous,,X1,RR-X1,candidates RR-X1 RR-X-1,',
		'',
	].join('\n'));
});
