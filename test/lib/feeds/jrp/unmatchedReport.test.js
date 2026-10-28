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
	ambiguous: [
		{ brandLabel: 'KC HiLiTES', jrpSku: 'KCH0100', oemSku: '0100', productSku: 'KCH-0100', otherCandidates: ['KCH-100', '=KCH-0100B'] },
	],
	duplicates: [{ brandLabel: 'Bilstein', jrpSku: 'BIL7', oemSku: '7', reason: 'duplicate-jrpsku' }],
	collisions: [{ brandLabel: 'Holley', jrpSku: 'HOL121-25', oemSku: '121-25', productSku: 'HOL-12-125', keptJrpSku: 'HOL12-125', reason: 'feed-collision' }],
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

test('the JSON body carries the run, the counts and the full lists', () => {
	const generatedAt = new Date('2026-10-27T13:00:00Z');
	const body = JSON.parse(buildReportJson({ runId: 42, generatedAt, counts: { matched: 3 }, ...LISTS }));
	assert.deepStrictEqual(body, {
		feed: 'jrp-ftp',
		runId: 42,
		generatedAt: '2026-10-27T13:00:00.000Z',
		counts: { matched: 3, unmatched: 2, ambiguous: 1, duplicates: 1, collisions: 1, inactive: 1, stale: 1 },
		unmatched: LISTS.unmatched,
		ambiguous: LISTS.ambiguous,
		duplicates: LISTS.duplicates,
		collisions: LISTS.collisions,
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
		'"ambiguous","KC HiLiTES","KCH0100","0100","KCH-0100","ambiguous:KCH-100|=KCH-0100B"',
		'"duplicate","Bilstein","BIL7","7","","duplicate-jrpsku"',
		'"collision","Holley","HOL121-25","121-25","HOL-12-125","feed-collision:kept=HOL12-125"',
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

test('the sample lists mapping gaps first, one brand at a time', () => {
	const rows = [
		...Array.from({ length: 40 }, (_, i) => ({ brandLabel: 'AlphaRex', jrpSku: `A${i}`, oemSku: `${i}`, reason: 'no-sku-match' })),
		{ brandLabel: 'Zone', jrpSku: 'Z1', oemSku: '1', reason: 'no-brand-mapping' },
		{ brandLabel: 'Zone', jrpSku: 'Z2', oemSku: '2', reason: 'no-brand-mapping' },
		{ brandLabel: 'Bestop', jrpSku: 'B1', oemSku: '1', reason: 'no-brand-mapping' },
	];
	const sample = formatSample(rows);
	assert.deepStrictEqual(sample.slice(0, 4), [
		'Bestop | B1 | 1 | no-brand-mapping',
		'Zone | Z1 | 1 | no-brand-mapping',
		'Zone | Z2 | 2 | no-brand-mapping',
		'AlphaRex | A0 | 0 | no-sku-match',
	]);
	assert.strictEqual(sample.length, 25);
});

test('the remaining slots rotate across brand labels in a deterministic order', () => {
	const rowsFor = (brand, count) => Array.from({ length: count }, (_, i) => ({ brandLabel: brand, jrpSku: `${brand}${i}`, oemSku: `${i}`, reason: 'no-sku-match' }));
	const rows = [...rowsFor('Rugged', 30), ...rowsFor('AlphaRex', 30), ...rowsFor('Mopar', 2)];
	const sample = formatSample(rows);
	assert.deepStrictEqual(sample.slice(0, 7).map((line) => line.split(' | ')[1]), [
		'AlphaRex0', 'Mopar0', 'Rugged0', 'AlphaRex1', 'Mopar1', 'Rugged1', 'AlphaRex2',
	]);
	assert.strictEqual(sample.length, 25);
	assert.deepStrictEqual(formatSample(rows), sample, 'same input, same sample');
});

test('an ambiguous candidate list that starts like a formula is neutralized', () => {
	const csv = buildReportCsv({
		unmatched: [],
		ambiguous: [{ brandLabel: '@B', jrpSku: '+J', oemSku: '-1', productSku: '=P', otherCandidates: [] }],
		inactive: [],
		stale: [],
	});
	assert.strictEqual(csv.trim().split('\n')[1], '"ambiguous","\'@B","\'+J","\'-1","\'=P","ambiguous:"');
});
