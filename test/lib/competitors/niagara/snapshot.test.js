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

test('validateSnapshot accepts payload v1 from niagara', () => {
	const payload = { schemaVersion: 1, source: 'niagara', items: [goodItem], collection: {} };
	assert.strictEqual(validateSnapshot(payload), payload);
});

test('validateSnapshot refuses another source, another version or broken items', () => {
	assert.throws(() => validateSnapshot({ schemaVersion: 1, source: 'tdot', items: [] }), /NIAGARA_BAD_SNAPSHOT/);
	assert.throws(() => validateSnapshot({ schemaVersion: 2, source: 'niagara', items: [] }), /schemaVersion/);
	assert.throws(() => validateSnapshot({ schemaVersion: 1, source: 'niagara', items: [{ ...goodItem, price: 0 }] }), /item 0/);
	assert.throws(() => validateSnapshot({ schemaVersion: 1, source: 'niagara', items: [{ ...goodItem, url: 'javascript:x' }] }), /item 0/);
	assert.throws(() => validateSnapshot(null), /NIAGARA_BAD_SNAPSHOT/);
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
