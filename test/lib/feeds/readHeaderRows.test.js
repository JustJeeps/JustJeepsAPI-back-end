const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

const { readHeaderRows, CSV_HEAD_BYTES } = require('../../../lib/feeds/readHeaderRows');
const { normalizeHeader, findHeaderRow } = require('../../../lib/feeds/fileSignature');

const workbookBuffer = (sheets) => {
	const workbook = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
	}
	return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

test('xlsx: reads the first sheet by default and the named sheet when asked', () => {
	const buffer = workbookBuffer({
		Cover: [['Key Parts Inc'], ['Price List']],
		'Price List': [[], [], ['Item', 'Description', 'Unit Price'], ['00-54', 'ROCKER', 38]],
	});

	const first = readHeaderRows(buffer, { fileName: 'any name.xlsx' });
	assert.deepStrictEqual(normalizeHeader(first[0]), ['Key Parts Inc']);

	const named = readHeaderRows(buffer, { fileName: 'any name.xlsx', sheet: 'Price List' });
	assert.strictEqual(findHeaderRow(named, ['Item', 'Description', 'Unit Price']), 2);
});

test('xlsx: a named sheet that is not there is a typed error', () => {
	const buffer = workbookBuffer({ Sheet1: [['a', 'b']] });
	assert.throws(
		() => readHeaderRows(buffer, { fileName: 'f.xlsx', sheet: 'Price List' }),
		(error) => error.code === 'FEED_SHEET_NOT_FOUND' && /Sheet1/.test(error.message)
	);
});

test('xlsx: only the first scanRows rows are read', () => {
	const rows = Array.from({ length: 100 }, (_, index) => [`row ${index}`]);
	const buffer = workbookBuffer({ Sheet1: rows });
	assert.strictEqual(readHeaderRows(buffer, { fileName: 'f.xlsx' }).length, 20);
	assert.strictEqual(readHeaderRows(buffer, { fileName: 'f.xlsx', scanRows: 5 }).length, 5);
});

test('csv: parses the header with quoted cells and keeps only the first rows', () => {
	const text = 'VendorName,VCPN,"Long, Description",Cost\n"AIR LIFT",A1,"STUD, MOUNT",10\nB,B2,x,20\n';
	const rows = readHeaderRows(Buffer.from(text), { fileName: 'Inventory.csv' });
	assert.deepStrictEqual(normalizeHeader(rows[0]), ['VendorName', 'VCPN', 'Long, Description', 'Cost']);
	assert.strictEqual(rows.length, 3);
});

test('csv: a buffer cut mid-line drops the partial last line and still finds the header', () => {
	// A 64KB range of a 460MB file ends wherever the byte count lands.
	const line = 'AIR LIFT,A1316060,A13,"=""16060""",COMP VIARIR BLK BOX,145.21\n';
	let text = 'VendorName,VCPN,VendorCode,PartNumber,LongDescription,JobberPrice\n';
	while (text.length < CSV_HEAD_BYTES + 100) text += line;
	const buffer = Buffer.from(text).subarray(0, CSV_HEAD_BYTES);
	assert.notStrictEqual(buffer[buffer.length - 1], 0x0a, 'the fixture has to be cut inside a line');

	const rows = readHeaderRows(buffer, { fileName: 'SpecialOrder.csv', truncated: true });
	assert.deepStrictEqual(normalizeHeader(rows[0]), ['VendorName', 'VCPN', 'VendorCode', 'PartNumber', 'LongDescription', 'JobberPrice']);
	assert.strictEqual(rows.length, 20);
	// Every row kept is a whole line: the cut one never made it in.
	for (const row of rows) assert.strictEqual(normalizeHeader(row).length, 6);
});

test('csv: a short file with the truncated flag still keeps its complete lines', () => {
	const rows = readHeaderRows(Buffer.from('a,b\n1,2\n3,'), { fileName: 'x.csv', truncated: true });
	assert.deepStrictEqual(rows.map(normalizeHeader), [['a', 'b'], ['1', '2']]);
});

test('csv: a UTF-8 BOM does not become part of the first column', () => {
	const rows = readHeaderRows(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Type,,Date\n')]), { fileName: 'x.csv' });
	assert.deepStrictEqual(normalizeHeader(rows[0]), ['Type', '', 'Date']);
});

test('csv: an empty buffer gives no rows', () => {
	assert.deepStrictEqual(readHeaderRows(Buffer.alloc(0), { fileName: 'x.csv' }), []);
});
