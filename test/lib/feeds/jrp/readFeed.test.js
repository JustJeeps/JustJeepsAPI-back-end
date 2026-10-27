const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { readFeed } = require('../../../../lib/feeds/jrp/readFeed');

const FIXTURE = path.join(__dirname, 'fixtures', 'JUSJEE-sample.csv');

test('reads the real feed layout: 25 rows, quotes, 4+ and the -0.01 MAP sentinel', async () => {
	const result = await readFeed(FIXTURE, { stockPlusValue: 4 });
	assert.strictEqual(result.rowsRead, 25);
	assert.strictEqual(result.rows.length, 25);
	assert.deepStrictEqual(result.invalid, []);
	assert.strictEqual(result.rows.filter((row) => row.stockText === '4+').length, 3);
	assert.ok(result.rows.filter((row) => row.stockText === '4+').every((row) => row.stock === 4));
	const kc = result.rows.find((row) => row.jrpSku === 'KCH0100');
	assert.match(kc.description, /^6" SlimLite/, 'the doubled quote is unescaped');
	const husky = result.rows.find((row) => row.jrpSku === 'HUS11991');
	assert.strictEqual(husky.map, null);
	assert.strictEqual(husky.mapBelowCost, true);
});

test('invalid rows are counted apart with their reason and JRPSKU', async () => {
	const fakeStream = async (_filePath, { transform }, onBatch) => {
		const raws = [
			{ BRAND: 'AlphaRex', JRPSKU: 'ARX1', OEMSKU: '1', DESCRIPTION: '', 'IN-STOCK': '9', COST: '1', MAP: '2' },
			{ BRAND: 'AlphaRex', JRPSKU: 'ARX2', OEMSKU: '2', DESCRIPTION: '', 'IN-STOCK': '1', COST: '1', MAP: '2' },
		];
		await onBatch(raws.map(transform));
		return { rowsRead: raws.length };
	};
	const result = await readFeed('ignored.csv', { stockPlusValue: 4, streamCsv: fakeStream });
	assert.strictEqual(result.rowsRead, 2);
	assert.deepStrictEqual(result.rows.map((row) => row.jrpSku), ['ARX2']);
	assert.deepStrictEqual(result.invalid, [{ jrpSku: 'ARX1', reason: 'bad-stock' }]);
});
