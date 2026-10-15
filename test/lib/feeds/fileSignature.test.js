const test = require('node:test');
const assert = require('node:assert');

const {
	normalizeCell,
	normalizeHeader,
	findHeaderRow,
	classify,
	diffSignature,
} = require('../../../lib/feeds/fileSignature');

const GOLD_SHEET = ['Quadratec PN', 'MPN', 'Description', 'UPC Code', 'Brand', 'Retail Price', 'Wholesale Price', 'Shipping Surcharge'];
const GOLD_KIT = ['Name', 'Display Name', 'Retail Price', 'Wholesale Price', 'Brand'];

test('normalizeCell trims, collapses whitespace runs including newlines, keeps case', () => {
	assert.strictEqual(normalizeCell('  Retailer to\nConsumer '), 'Retailer to Consumer');
	assert.strictEqual(normalizeCell('WARN\t Part\r\n  Number'), 'WARN Part Number');
	assert.strictEqual(normalizeCell('ITEM'), 'ITEM');
	assert.strictEqual(normalizeCell(null), '');
	assert.strictEqual(normalizeCell(undefined), '');
	assert.strictEqual(normalizeCell(45470), '45470');
});

test('normalizeHeader drops leading and trailing empty cells and keeps the ones in the middle', () => {
	// The real WARN header row: a blank first column, two blank columns inside.
	const warnRow = ['', 'Product Category', '', 'WARN Part Number', 'Product Description', '', 'Retailer to\nConsumer', 'MSRP/CAN', '', ''];
	assert.deepStrictEqual(normalizeHeader(warnRow), ['Product Category', '', 'WARN Part Number', 'Product Description', '', 'Retailer to Consumer', 'MSRP/CAN']);
	assert.deepStrictEqual(normalizeHeader([null, undefined, '  ']), []);
	assert.deepStrictEqual(normalizeHeader('not an array'), []);
});

test('findHeaderRow finds the header on row 7 (KeyParts) and ignores the rows above it', () => {
	const rows = [
		['', 'Key Parts Inc', ''],
		['', 'Price List', ''],
		['', '', ''],
		['Date', 45470, ''],
		[],
		[],
		['Item', 'Description', 'Unit Price'],
		['00-54-00-1', '84-90 BMW 3-SER ROCKER PANEL 2DR', 38],
	];
	assert.strictEqual(findHeaderRow(rows, ['Item', 'Description', 'Unit Price']), 6);
	assert.strictEqual(findHeaderRow(rows, ['Item', 'Description', 'Unit Price'], { scanRows: 5 }), -1);
	assert.strictEqual(findHeaderRow([], ['Item']), -1);
	assert.strictEqual(findHeaderRow(rows, []), -1);
});

test('a reordered header is rejected (positional seeds depend on the order)', () => {
	const reordered = ['MPN', 'Quadratec PN', 'Description', 'UPC Code', 'Brand', 'Retail Price', 'Wholesale Price', 'Shipping Surcharge'];
	assert.strictEqual(findHeaderRow([reordered, ['x']], GOLD_SHEET), -1);
	assert.strictEqual(findHeaderRow([GOLD_SHEET], GOLD_SHEET), 0);
});

test('an extra or a missing column is rejected', () => {
	assert.strictEqual(findHeaderRow([[...GOLD_SHEET, 'Notes']], GOLD_SHEET), -1);
	assert.strictEqual(findHeaderRow([GOLD_SHEET.slice(0, -1)], GOLD_SHEET), -1);
	// Trailing blanks in the file are not a column.
	assert.strictEqual(findHeaderRow([[...GOLD_SHEET, '', '']], GOLD_SHEET), 0);
});

test('whitespace and newlines inside the file header do not break the match', () => {
	const row = ['', ' Product Category', '', 'WARN Part\nNumber', 'Product  Description', '', 'Retailer to\nConsumer', 'MSRP/CAN '];
	const signature = ['Product Category', '', 'WARN Part Number', 'Product Description', '', 'Retailer to Consumer', 'MSRP/CAN'];
	assert.strictEqual(findHeaderRow([['title'], ['', 'Effective'], ['', 'Minimum'], row], signature), 3);
});

test('diffSignature reports missing and extra columns from the row that overlaps the most', () => {
	const rows = [['junk', 'title'], GOLD_KIT, ['11000-0009K', 'QUADRATOP', 707.97, 349.98, '']];
	const diff = diffSignature(rows, GOLD_SHEET);
	assert.strictEqual(diff.foundRowIndex, 1);
	assert.deepStrictEqual(diff.missing, ['Quadratec PN', 'MPN', 'Description', 'UPC Code', 'Shipping Surcharge']);
	assert.deepStrictEqual(diff.extra, ['Name', 'Display Name']);

	// Reordered: nothing missing, nothing extra; the caller words it.
	const reordered = [[...GOLD_SHEET].reverse()];
	assert.deepStrictEqual(diffSignature(reordered, GOLD_SHEET), { missing: [], extra: [], foundRowIndex: 0 });

	assert.deepStrictEqual(diffSignature([], GOLD_SHEET), { missing: GOLD_SHEET, extra: [], foundRowIndex: -1 });
});

const candidates = [
	{ feed: 'quadratec', fileName: 'pricingSheet_quad.xlsx', label: 'Quadratec gold sheet', signature: GOLD_SHEET, sheet: null },
	{ feed: 'quadratec', fileName: 'pricingKit_quad.xlsx', label: 'Quadratec gold kit', signature: GOLD_KIT, sheet: null },
	{ feed: 'keystone-ftp', fileName: 'Inventory.csv', label: 'Keystone inventory', signature: ['VendorName', 'VCPN', 'Cost'], sheet: null },
	{ feed: 'keystone-ftp', fileName: 'SpecialOrder.csv', label: 'Keystone special order', signature: ['VendorName', 'VCPN', 'Cost'], sheet: null },
];

test('classify picks the file by its columns whatever the file was called', () => {
	const result = classify([GOLD_KIT, ['11000-0009K', 'x', 1, 2, '']], candidates, { originalName: 'gold kit 10.13.26.xlsx' });
	assert.strictEqual(result.ambiguous, false);
	assert.deepStrictEqual(result.matches.map((m) => m.fileName), ['pricingKit_quad.xlsx']);

	// Even when called by the OTHER canonical name: the columns win.
	const misnamed = classify([GOLD_KIT], candidates, { originalName: 'pricingSheet_quad.xlsx' });
	assert.deepStrictEqual(misnamed.matches.map((m) => m.fileName), ['pricingKit_quad.xlsx']);

	assert.deepStrictEqual(classify([['foo', 'bar']], candidates, { originalName: 'pricingKit_quad.xlsx' }), { matches: [], ambiguous: false });
});

test('Keystone: two files share a signature, the original name breaks the tie, otherwise ambiguous', () => {
	const rows = [['VendorName', 'VCPN', 'Cost'], ['AIR LIFT', 'A1', '1']];

	const special = classify(rows, candidates, { originalName: 'specialorder.CSV' });
	assert.strictEqual(special.ambiguous, false);
	assert.deepStrictEqual(special.matches.map((m) => m.fileName), ['SpecialOrder.csv']);

	const inventory = classify(rows, candidates, { originalName: 'Inventory.csv' });
	assert.deepStrictEqual(inventory.matches.map((m) => m.fileName), ['Inventory.csv']);

	const unknown = classify(rows, candidates, { originalName: 'keystone-2026-10-14.csv' });
	assert.strictEqual(unknown.ambiguous, true);
	assert.deepStrictEqual(unknown.matches.map((m) => m.fileName), ['Inventory.csv', 'SpecialOrder.csv']);

	const noName = classify(rows, candidates);
	assert.strictEqual(noName.ambiguous, true);
});

test('classify checks a candidate against the rows of its own sheet when a reader is given', () => {
	const sheets = {
		'Price List': [[], ['Item', 'Description', 'Unit Price']],
		Cover: [['Key Parts Inc']],
	};
	const keyparts = { feed: 'keyparts', fileName: 'KeyParts-price-file.xlsx', label: 'KeyParts price list', signature: ['Item', 'Description', 'Unit Price'], sheet: 'Price List' };
	const result = classify(sheets.Cover, [keyparts, ...candidates], { originalName: 'x.xlsx', rowsForSheet: (name) => sheets[name] });
	assert.deepStrictEqual(result.matches.map((m) => m.fileName), ['KeyParts-price-file.xlsx']);
	// Without the reader the first sheet is all there is.
	assert.deepStrictEqual(classify(sheets.Cover, [keyparts], { originalName: 'x.xlsx' }).matches, []);
});
