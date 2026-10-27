const test = require('node:test');
const assert = require('node:assert');

const {
	reportKeys, buildReportJson, buildReportCsv, formatSample, SAMPLE_SIZE,
} = require('../../../../lib/feeds/jrp/unmatchedReport');

const LISTS = {
	unmatched: [
		{ brandLabel: 'AlphaRex', jrpSku: 'ARX1', oemSku: '1', reason: 'no-sku-match' },
		{ brandLabel: 'Rugged, "Ridge"', jrpSku: 'RUG1', oemSku: '=SUM(A1)', reason: 'no-brand-mapping' },
	],
	inactive: [{ brandLabel: 'Bilstein', jrpSku: 'BIL1', oemSku: '1', prefix: 'BIL', reason: 'skipped-inactive' }],
	stale: [{ vendorSku: 'ARX9', productSku: 'ALR-9' }],
};

test('report keys are deterministic under reports/jrp-ftp/<runId>/, outside the feeds/ retention prefix', () => {
	const keys = reportKeys({ runId: 42 });
	assert.deepStrictEqual(keys, {
		json: 'reports/jrp-ftp/42/unmatched.json',
		csv: 'reports/jrp-ftp/42/unmatched.csv',
	});
	assert.ok(Object.values(keys).every((key) => !key.startsWith('feeds/')));
	assert.strictEqual(reportKeys({ runId: 7, reportPrefix: 'tmp' }).json, 'tmp/jrp-ftp/7/unmatched.json');
});

test('report keys refuse a missing run id or report prefix', () => {
	assert.throws(() => reportKeys({ runId: null }), /runId/);
	assert.throws(() => reportKeys({ reportPrefix: '', runId: 1 }), /reportPrefix/);
});

test('the JSON body carries the run, the counts and the three full lists', () => {
	const generatedAt = new Date('2026-10-27T13:00:00Z');
	const body = JSON.parse(buildReportJson({ runId: 42, generatedAt, counts: { matched: 3 }, ...LISTS }));
	assert.deepStrictEqual(body, {
		feed: 'jrp-ftp',
		runId: 42,
		generatedAt: '2026-10-27T13:00:00.000Z',
		counts: { matched: 3, unmatched: 2, inactive: 1, stale: 1 },
		unmatched: LISTS.unmatched,
		inactive: LISTS.inactive,
		stale: LISTS.stale,
	});
});

test('the CSV has one line per entry, quoted, with formula text neutralized', () => {
	const lines = buildReportCsv(LISTS).trim().split('\n');
	assert.deepStrictEqual(lines, [
		'"list","brand_label","jrpsku","oemsku","product_sku","reason"',
		'"unmatched","AlphaRex","ARX1","1","","no-sku-match"',
		'"unmatched","Rugged, ""Ridge""","RUG1","\'=SUM(A1)","","no-brand-mapping"',
		'"inactive","Bilstein","BIL1","1","","skipped-inactive"',
		'"stale","","ARX9","","ALR-9","missing-from-feed"',
	]);
});

test('the log sample holds at most 25 unmatched lines with brand, JRPSKU, OEMSKU and reason', () => {
	const many = Array.from({ length: 30 }, (_, i) => ({ brandLabel: 'B', jrpSku: `J${i}`, oemSku: `O${i}`, reason: 'no-sku-match' }));
	const sample = formatSample(many);
	assert.strictEqual(SAMPLE_SIZE, 25);
	assert.strictEqual(sample.length, 25);
	assert.strictEqual(sample[0], 'B | J0 | O0 | no-sku-match');
	assert.deepStrictEqual(formatSample([]), []);
});
