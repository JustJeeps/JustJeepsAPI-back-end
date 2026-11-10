const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFeed } = require('../../../../lib/feeds/grandwest/readFeed');

const FIXTURE = path.join(__dirname, 'fixtures', 'grandwest-sample.csv');

test('the sample file is read record by record, even with a description on two lines', async () => {
	const feed = await readFeed(FIXTURE);

	assert.strictEqual(feed.rowsRead, 15);
	assert.strictEqual(feed.rows.length, 13);
	const lift = feed.rows.find((row) => row.item === 'BDS-002000');
	assert.deepStrictEqual(lift, { item: 'BDS-002000', lineCode: 'BDS', part: '002000', cost: 1084.31, stock: 6, stockText: '6' });
	assert.strictEqual(feed.rows.find((row) => row.item === 'BDS-001402').stock, 0, 'blank quantity is 0');
});

test('invalid rows are kept apart with the item, line code and reason', async () => {
	const feed = await readFeed(FIXTURE);

	assert.deepStrictEqual(feed.invalid, [
		{ item: 'AFE-40-19019', lineCode: 'AFE', reason: 'bad-cost' },
		{ item: 'BDS-XYZ', lineCode: 'RCT', reason: 'item-prefix-mismatch' },
	]);
});

test('spaces inside a quoted header cell do not hide a column', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grandwest-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'spaced.csv');
	fs.writeFileSync(file, '"Item ","LineCode","Desciption","UnitPrice","ListPrice","Quantity","UPC"\nBDS-1,BDS,X,10,12,2,\n');

	const feed = await readFeed(file);

	assert.strictEqual(feed.rows.length, 1);
	assert.strictEqual(feed.rows[0].item, 'BDS-1');
});
