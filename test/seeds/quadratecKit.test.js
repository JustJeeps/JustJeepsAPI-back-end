const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const {
	KIT_HEADER,
	kitRowToSheetRow,
	loadKitSheetRows,
	mergeKitRows,
} = require('../../prisma/seeds/api-calls/quadratec-kit');
const quadratecCost = require('../../prisma/seeds/api-calls/quadratec-excel');

// No console inside the parser while the runner is listening (its stdout is the
// runner's IPC channel), so every call gets a silent logger that records calls.
function makeLogger() {
	const logs = [];
	const warns = [];
	return { logs, warns, log: (line) => logs.push(line), warn: (line) => warns.push(line) };
}

const SHEET_HEADER = ['Quadratec PN', 'MPN', 'Description', 'UPC Code', 'Brand', 'Retail Price', 'Wholesale Price', 'Shipping Surcharge'];

function writeWorkbook(filePath, rows) {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
	XLSX.writeFile(workbook, filePath);
	return filePath;
}

let dir;
test.before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quadratec-kit-'));
});
test.after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

test('kitRowToSheetRow gives a kit row the shape it had in the gold sheet', () => {
	const row = kitRowToSheetRow({
		Name: ' 11000-0009K ',
		'Display Name': 'QUADRATOP COMP W/ UP GRAY 88-95 YJ      KIT ',
		'Retail Price': 707.97,
		'Wholesale Price': ' $349.98 ',
		Brand: null,
	});
	assert.deepStrictEqual(row, {
		'Quadratec PN': '11000-0009K',
		MPN: '11000-0009K',
		Description: 'QUADRATOP COMP W/ UP GRAY 88-95 YJ      KIT',
		'UPC Code': '',
		Brand: '',
		'Retail Price': 707.97,
		'Wholesale Price': '$349.98',
		'Shipping Surcharge': '- None -',
	});
	assert.strictEqual(kitRowToSheetRow({ Name: 'X', Brand: ' Synergy ' }).Brand, 'Synergy');
	assert.strictEqual(kitRowToSheetRow({ Name: 'X' })['Wholesale Price'], null);
});

test('loadKitSheetRows: absent file is flagged and returns no rows', () => {
	const result = loadKitSheetRows({ filePath: path.join(dir, 'nope.xlsx') });
	assert.strictEqual(result.present, false);
	assert.deepStrictEqual(result.rows, []);
	assert.deepStrictEqual(result.counts, { read: 0, noName: 0, noWholesale: 0, nullBrand: 0 });
});

test('loadKitSheetRows: reads the rows, counts the gaps and skips rows without a Name', () => {
	const filePath = writeWorkbook(path.join(dir, 'kit-ok.xlsx'), [
		[' Name', 'Display Name ', 'Retail Price', 'Wholesale Price', 'Brand', ''],
		['11000-0009K', 'TOP KIT', 707.97, 349.98],
		['22000-0001K', 'NO PRICE KIT', 100, '- None -', 'Synergy'],
		['', 'NO NAME', 1, 1, 'X'],
		['33000-0001K', 'STRING PRICE', '$20.00', '$10.00', 'Rugged Ridge'],
	]);
	const result = loadKitSheetRows({ filePath });
	assert.strictEqual(result.present, true);
	assert.deepStrictEqual(result.counts, { read: 3, noName: 1, noWholesale: 1, nullBrand: 1 });
	assert.deepStrictEqual(result.rows.map((row) => row['Quadratec PN']), ['11000-0009K', '22000-0001K', '33000-0001K']);
	assert.strictEqual(result.rows[0].Brand, '');
	assert.strictEqual(result.rows[1].Brand, 'Synergy');
	assert.strictEqual(result.rows[1].MPN, '22000-0001K');
	assert.strictEqual(result.rows[1]['Shipping Surcharge'], '- None -');
});

test('loadKitSheetRows: a different header is refused and the error names expected vs found', () => {
	const filePath = writeWorkbook(path.join(dir, 'kit-bad.xlsx'), [
		SHEET_HEADER,
		['1', '1', 'd', '', 'B', 1, 1, '- None -'],
	]);
	assert.throws(() => loadKitSheetRows({ filePath }), (error) => {
		assert.match(error.message, /kit-bad\.xlsx/);
		assert.match(error.message, new RegExp(`Expected \\[${KIT_HEADER.join(', ')}\\]`));
		assert.match(error.message, /found \[Quadratec PN, MPN, Description/);
		return true;
	});
	// reordered columns are refused too: the reader is positional
	const reordered = writeWorkbook(path.join(dir, 'kit-reordered.xlsx'), [
		['Name', 'Display Name', 'Wholesale Price', 'Retail Price', 'Brand'],
	]);
	assert.throws(() => loadKitSheetRows({ filePath: reordered }), /unexpected header/);
});

test('mergeKitRows appends the kits below the sheet and the sheet wins on a shared PN', () => {
	const sheetRows = [
		{ 'Quadratec PN': 'A1', MPN: 'M1', Brand: 'Synergy', 'Wholesale Price': 10 },
		{ 'Quadratec PN': ' K2 ', MPN: 'K2', Brand: 'Rugged Ridge', 'Wholesale Price': 20 },
	];
	const kitRows = [
		kitRowToSheetRow({ Name: 'K2', 'Display Name': 'dup', 'Wholesale Price': 99, Brand: 'Rugged Ridge' }),
		kitRowToSheetRow({ Name: 'K3', 'Display Name': 'new', 'Wholesale Price': 30, Brand: 'Rugged Ridge' }),
	];
	const merged = mergeKitRows(sheetRows, kitRows);
	assert.strictEqual(merged.appended, 1);
	assert.strictEqual(merged.skipped, 1);
	assert.deepStrictEqual(merged.rows.map((row) => row['Quadratec PN']), ['A1', ' K2 ', 'K3']);
	assert.strictEqual(merged.rows[1]['Wholesale Price'], 20, 'the sheet row is kept, not the kit row');
});

const sheetFixture = [
	SHEET_HEADER,
	['16315-6512', '8047', 'SYNERGY FIXED LOWER CONTROL ARMS FR JK', '- None -', 'Synergy Manufacturing', 315, 245.7, '- None -'],
	['99998-2200', '99998-2200', 'DRAKE FIRE EXT W/ MOUNTING CLAMPS', null, 'DV8 Offroad', 124.98, 98.11, '- None -'],
];
const kitFixture = [
	KIT_HEADER,
	['99998-2200', 'DUPLICATE OF A SHEET ROW', 1, 1, 'DV8 Offroad'],
	['11000-0009K', 'QUADRATOP COMP W/ UP GRAY 88-95 YJ      KIT', 707.97, 349.98, 'QuadraTop'],
	['12345-0001K', 'SWAPPED PRICES KIT', 100, 150, 'Rugged Ridge'],
	['13579-0001K', 'NO BRAND KIT', 50, 25],
	['24680-0001K', 'NO WHOLESALE KIT', 50, '- None -', 'Rugged Ridge'],
];

test('quadratecCost appends the kit rows and parses them with the sheet rules', () => {
	const sheetPath = writeWorkbook(path.join(dir, 'pricingSheet_quad.xlsx'), sheetFixture);
	const kitPath = writeWorkbook(path.join(dir, 'pricingKit_quad.xlsx'), kitFixture);
	const logger = makeLogger();

	const rows = quadratecCost({ sheetPath, kitPath, logger });

	assert.deepStrictEqual(
		rows.map((row) => row.quadratec_sku),
		['16315-6512', '99998-2200', '11000-0009K', '12345-0001K', '13579-0001K', '24680-0001K'],
		'sheet rows first, then the kits, minus the PN the sheet already has'
	);
	// sheet wins on the shared PN
	assert.strictEqual(rows[1].wholesalePrice, 98.11);
	assert.strictEqual(rows[1].quadratec_code, 'DV8 Offroad99998-2200');

	// QuadraTop is a "use Quadratec PN" brand: code = brand + PN, no alt (MPN == PN)
	const quadraTop = rows[2];
	assert.strictEqual(quadraTop.quadratec_code, 'QuadraTop11000-0009K');
	assert.strictEqual(quadraTop.quadratec_code_alt, null);
	assert.strictEqual(quadraTop.MPN, '11000-0009K');
	assert.strictEqual(quadraTop.wholesalePrice, 349.98);
	assert.strictEqual(quadraTop.retailPrice, 707.97);
	assert.strictEqual(quadraTop.shippingSurcharge, null);

	// the existing price swap guard applies to kits too
	const swapped = rows[3];
	assert.strictEqual(swapped.prices_swapped, true);
	assert.strictEqual(swapped.wholesalePrice, 100);
	assert.strictEqual(swapped.retailPrice, 150);
	assert.strictEqual(swapped.quadratec_code, 'Rugged Ridge12345-0001K');

	// null brand: bare PN code, same as an empty-brand sheet row
	assert.strictEqual(rows[4].brand, '');
	assert.strictEqual(rows[4].quadratec_code, '13579-0001K');

	// no wholesale price stays null (the seed drops it later, as for sheet rows)
	assert.strictEqual(rows[5].wholesalePrice, null);

	assert.strictEqual(logger.warns.length, 0);
	assert.strictEqual(logger.logs.length, 1);
	assert.match(logger.logs[0], /5 read, 4 appended, 1 already in the sheet \(sheet wins\), 1 without wholesale price, 1 without brand \(1 of them with a bare PN code\)/);
});

test('quadratecCost without the kit file behaves as before and warns once', () => {
	const sheetPath = writeWorkbook(path.join(dir, 'pricingSheet_only.xlsx'), sheetFixture);
	const logger = makeLogger();

	const rows = quadratecCost({ sheetPath, kitPath: path.join(dir, 'absent-kit.xlsx'), logger });

	assert.deepStrictEqual(rows.map((row) => row.quadratec_sku), ['16315-6512', '99998-2200']);
	assert.strictEqual(rows[0].quadratec_code, 'Synergy Manufacturing8047');
	assert.strictEqual(rows[0].quadratec_code_alt, 'Synergy Manufacturing16315-6512');
	assert.strictEqual(logger.logs.length, 0);
	assert.deepStrictEqual(logger.warns.length, 1);
	assert.match(logger.warns[0], /absent-kit\.xlsx not found/);
});

test('quadratecCost refuses a kit file with the wrong header', () => {
	const sheetPath = writeWorkbook(path.join(dir, 'pricingSheet_ok.xlsx'), sheetFixture);
	const kitPath = writeWorkbook(path.join(dir, 'wrong-kit.xlsx'), sheetFixture);
	assert.throws(() => quadratecCost({ sheetPath, kitPath, logger: makeLogger() }), /unexpected header/);
});
