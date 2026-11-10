const test = require('node:test');
const assert = require('node:assert');

const report = require('../../../../lib/feeds/grandwest/report');

const lists = () => ({
	unmatched: [{ item: 'GOR-X1', lineCode: 'GOR', prefix: 'GOR', part: 'X1', reason: 'no-sku-match' }],
	invalid: [{ item: 'AFE-40-19019', lineCode: 'AFE', reason: 'bad-cost' }],
	duplicates: [{ item: 'TYG-A1', lineCode: 'TYG', reason: 'duplicate-item', copies: 2 }],
	collisions: [{ item: 'HOL-121-25', lineCode: 'HOL', productSku: 'HOL-12-125', keptItem: 'HOL-12-125', reason: 'feed-collision' }],
	ambiguous: [{ item: 'BDS-1', lineCode: 'BDS', productSku: 'BDS-1', otherCandidates: ['BDS-1A'] }],
	stale: [{ vendorSku: 'BDS-OLD', productSku: 'BDS-OLD', reason: 'missing-from-feed' }],
	notCarried: [{ item: 'ACC-1', lineCode: 'ACC', reason: 'brand-not-carried' }, { item: 'ACC-2', lineCode: 'ACC', reason: 'brand-not-carried' }, { item: 'LAI-1', lineCode: 'LAI', reason: 'brand-not-carried' }],
});

test('report keys live outside feeds/ and are derived from the run id', () => {
	assert.deepStrictEqual(report.reportKeys({ runId: 7 }), { json: 'reports/grandwest/7/report.json', csv: 'reports/grandwest/7/report.csv' });
	assert.throws(() => report.reportKeys({ runId: null }), /runId/);
});

test('the CSV lists every row a person may want to look at, one list per line', () => {
	const csv = report.buildReportCsv(lists());
	const lines = csv.trim().split('\n');

	assert.strictEqual(lines[0], '"list","line_code","item","product_sku","reason"');
	assert.deepStrictEqual(lines.slice(1), [
		'"unmatched","GOR","GOR-X1","","no-sku-match"',
		'"invalid","AFE","AFE-40-19019","","bad-cost"',
		'"duplicate","TYG","TYG-A1","","duplicate-item:2-copies"',
		'"collision","HOL","HOL-121-25","HOL-12-125","feed-collision:kept=HOL-12-125"',
		'"ambiguous","BDS","BDS-1","BDS-1","ambiguous:BDS-1A"',
		'"stale","","BDS-OLD","BDS-OLD","missing-from-feed"',
	]);
});

test('brands we do not carry are counted per line code, not listed row by row', () => {
	const json = JSON.parse(report.buildReportJson({ runId: 7, generatedAt: new Date('2026-11-10T15:00:00Z'), counts: { matched: 3 }, ...lists() }));

	assert.strictEqual(json.feed, 'grandwest');
	assert.deepStrictEqual(json.notCarriedByLineCode, { ACC: 2, LAI: 1 });
	assert.strictEqual(json.notCarried, undefined);
	assert.strictEqual(json.counts.matched, 3);
	assert.strictEqual(json.counts.notCarried, 3);
	assert.strictEqual(json.unmatched.length, 1);
});

test('a cell that starts like a formula is neutralized for spreadsheets', () => {
	const csv = report.buildReportCsv({ ...lists(), unmatched: [{ item: '=HYPERLINK("x")', lineCode: 'GOR', reason: 'no-sku-match' }] });
	assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
});
