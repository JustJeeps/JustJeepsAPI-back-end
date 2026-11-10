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

function writeTemp(t, name, body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grandwest-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
}

const HEADER = 'Item,LineCode,Desciption,UnitPrice,ListPrice,Quantity,UPC\n';

test('a quote that opens and never closes swallows the next rows: they are flagged, not priced', async (t) => {
	const file = writeTemp(t, 'broken.csv', `${HEADER}BDS-1,BDS,"OPEN,10,12,1,\nWET-2,WET,MUD FLAP,52,71,3,\nCUR-3,CUR,"HITCH 5' 6"" BOX",180,246,4,\nGOR-4,GOR,STEP,99,120,1,\n`);

	const feed = await readFeed(file);

	assert.deepStrictEqual(feed.rows, [], 'BDS-1 must not get the 180 of CUR-3');
	assert.deepStrictEqual(feed.merged, [{ item: 'BDS-1', lineCode: 'BDS', reason: 'merged-rows' }]);
});

test('a bare inch mark in an unquoted description is flagged the same way', async (t) => {
	const file = writeTemp(t, 'bare.csv', `${HEADER}BDS-1,BDS,3" LIFT KIT,10,12,1,\nWET-2,WET,MUD FLAP,52,71,3,\n`);

	const feed = await readFeed(file);

	assert.strictEqual(feed.rows.length, 0);
	assert.strictEqual(feed.merged.length, 1);
});

test('a description on two lines is a healthy row, not a merge', async (t) => {
	const file = writeTemp(t, 'two-lines.csv', `${HEADER}BDS-1,BDS,"MAGNUM FORCE INTAKE 19-26 GM 1500/\r\n21-26 GM SUV 6.2L",10,12,1,\r\nWET-2,WET,MUD FLAP,52,71,3,\r\n`);

	const feed = await readFeed(file);

	assert.deepStrictEqual([feed.rows.length, feed.merged], [2, []]);
});

test('a swallowed row is caught whatever the length of its line code', async (t) => {
	const file = writeTemp(t, 'long-code.csv', `${HEADER}ACC-1,ACC,BOX 5'6" WIDE,10,12,1,\nBESTO-2,BESTO,MAT,999,1200,7,\nB-3,B,MAT,5,6,1,\n`);

	const feed = await readFeed(file);

	assert.deepStrictEqual(feed.rows, [], 'ACC-1 must not get the 999 of BESTO-2');
	assert.deepStrictEqual(feed.merged.map((row) => row.item), ['ACC-1']);
});

test('a two-line description with commas and dashes is not taken for a swallowed row', async (t) => {
	const file = writeTemp(t, 'healthy.csv', `${HEADER}BDS-1,BDS,"LIFT KIT\r\nJL-JT,4DR,GAS",10,12,1,\r\n`);

	const feed = await readFeed(file);

	assert.deepStrictEqual([feed.rows.length, feed.merged], [1, []]);
});

test('a trailing comma in the header adds no column and flags nothing', async (t) => {
	const file = writeTemp(t, 'trailing.csv', 'Item,LineCode,Desciption,UnitPrice,ListPrice,Quantity,UPC,\nBDS-1,BDS,X,10,12,2,,\n');

	const feed = await readFeed(file);

	assert.deepStrictEqual([feed.rows.length, feed.merged], [1, []]);
});

test('a header that is not on line 1, or a wrong delimiter, fails with that reason', async (t) => {
	const titled = writeTemp(t, 'titled.csv', `Grandwest price list\n${HEADER}BDS-1,BDS,X,10,12,2,\n`);
	const tabbed = writeTemp(t, 'tabbed.csv', `${HEADER.replace(/,/g, '\t')}BDS-1\tBDS\tX\t10\t12\t2\t\n`);

	await assert.rejects(readFeed(titled), /header.*line 1.*delimiter/i);
	await assert.rejects(readFeed(tabbed), /header.*line 1.*delimiter/i);
});
