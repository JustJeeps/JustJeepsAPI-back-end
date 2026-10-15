const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const XLSX = require('xlsx');

const { createSignatureCheck, verifyRows, MISMATCH_CODE } = require('../../../services/feeds/signatureCheck');
const feedsConfig = require('../../../config/feeds');
const { CSV_HEAD_BYTES } = require('../../../lib/feeds/readHeaderRows');

const spec = (feed, fileName) => feedsConfig.getFileSpec(feed, fileName);

const workbookBuffer = (sheets) => {
	const workbook = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
	}
	return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

// A store that serves one object per key from memory and records how it was
// asked: a CSV must be read by range, an xlsx in full.
function fakeStore(objects) {
	const calls = [];
	return {
		calls,
		getObjectRange: async (key, bytes) => {
			calls.push({ kind: 'range', key, bytes });
			const buffer = objects[key];
			return { buffer: buffer.subarray(0, bytes), totalBytes: buffer.length };
		},
		getObjectStream: async (key) => {
			calls.push({ kind: 'stream', key });
			return { body: Readable.from([objects[key]]), contentLength: objects[key].length };
		},
	};
}

test('verifyRows: ok with the header row index, otherwise the diff and a plain message', () => {
	const kit = spec('quadratec', 'pricingKit_quad.xlsx');
	assert.deepStrictEqual(verifyRows([['x'], kit.signature], kit), { ok: true, headerRowIndex: 1 });

	const sheet = spec('quadratec', 'pricingSheet_quad.xlsx');
	const result = verifyRows([kit.signature], sheet);
	assert.strictEqual(result.ok, false);
	assert.deepStrictEqual(result.extra, ['Name', 'Display Name']);
	assert.match(result.message, /Quadratec gold sheet \(pricingSheet_quad\.xlsx\)/);
	assert.match(result.message, /missing columns: "Quadratec PN"/);
	assert.match(result.message, /unexpected columns: "Name", "Display Name"/);
	assert.doesNotMatch(result.message, /rename/i);

	const reordered = verifyRows([[...sheet.signature].reverse()], sheet);
	assert.match(reordered.message, /different order/);
});

test('a stored CSV is checked through a ranged GET of its head only', async () => {
	const ctp = spec('ctp', 'CTPENT_Inventory.csv');
	const big = Buffer.from(`${ctp.signature.join(',')}\n${'A,B,C,D,E,F,1,2,3,4,5,Y,N,N,N\n'.repeat(10000)}`);
	const store = fakeStore({ 'feeds/ctp/x-CTPENT_Inventory.csv': big });
	const check = createSignatureCheck({ store, feedsConfig });

	const result = await check.verifyStoredObject({ feed: 'ctp', fileName: 'CTPENT_Inventory.csv', key: 'feeds/ctp/x-CTPENT_Inventory.csv' });
	assert.deepStrictEqual(result, { ok: true, headerRowIndex: 0 });
	assert.deepStrictEqual(store.calls, [{ kind: 'range', key: 'feeds/ctp/x-CTPENT_Inventory.csv', bytes: CSV_HEAD_BYTES }]);
});

test('a stored xlsx is read in full, on the sheet the spec names', async () => {
	const keyparts = spec('keyparts', 'KeyParts-price-file.xlsx');
	const good = workbookBuffer({ 'Price List': [[''], ['', 'Price List'], [], ['Date', 1], [], [], keyparts.signature, ['00-54', 'x', 38]] });
	const renamedTab = workbookBuffer({ Prices: [keyparts.signature] });
	const store = fakeStore({ 'k/good.xlsx': good, 'k/tab.xlsx': renamedTab });
	const check = createSignatureCheck({ store, feedsConfig });

	const ok = await check.verifyStoredObject({ feed: 'keyparts', fileName: 'KeyParts-price-file.xlsx', key: 'k/good.xlsx' });
	assert.deepStrictEqual(ok, { ok: true, headerRowIndex: 6 });
	assert.strictEqual(store.calls[0].kind, 'stream');

	// The seed reads the "Price List" sheet by name, so a workbook without it
	// is refused here rather than at 3am.
	const tab = await check.verifyStoredObject({ feed: 'keyparts', fileName: 'KeyParts-price-file.xlsx', key: 'k/tab.xlsx' });
	assert.strictEqual(tab.ok, false);
	assert.match(tab.message, /sheet "Price List" not found/);
});

test('bytes that are not a spreadsheet at all are a mismatch, not a crash', async () => {
	const store = fakeStore({ 'q/junk.xlsx': Buffer.from('this is not a zip') });
	const check = createSignatureCheck({ store, feedsConfig });
	const result = await check.verifyStoredObject({ feed: 'quadratec', fileName: 'pricingKit_quad.xlsx', key: 'q/junk.xlsx' });
	assert.strictEqual(result.ok, false);
	assert.match(result.message, /Quadratec gold kit/);
});

test('an xlsx above maxBytes is not downloaded', async () => {
	const store = fakeStore({ 'q/big.xlsx': Buffer.alloc(2048) });
	const check = createSignatureCheck({ store, feedsConfig });
	await assert.rejects(
		check.verifyStoredObject({ feed: 'quadratec', fileName: 'pricingKit_quad.xlsx', key: 'q/big.xlsx', maxBytes: 1024 }),
		(error) => error.code === 'FEED_FILE_TOO_LARGE'
	);
});

test('a name the feed does not have is a typed error, before any read', async () => {
	const store = fakeStore({});
	const check = createSignatureCheck({ store, feedsConfig });
	await assert.rejects(
		check.verifyStoredObject({ feed: 'quadratec', fileName: 'nope.csv', key: 'q/nope.csv' }),
		(error) => error.code === 'FEED_FILE_MISMATCH'
	);
	assert.deepStrictEqual(store.calls, []);
	assert.strictEqual(MISMATCH_CODE, 'FEED_FILE_SIGNATURE_MISMATCH');
});

test('classifyLocalFile: an Excel file only competes with Excel specs and a CSV with CSV specs', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigcheck-'));
	const check = createSignatureCheck({ store: fakeStore({}), feedsConfig });
	try {
		const kit = spec('quadratec', 'pricingKit_quad.xlsx');
		const kitPath = path.join(dir, 'gold kit 10.13.26.xlsx');
		fs.writeFileSync(kitPath, workbookBuffer({ WholesaleKitPricingSheetGoldRe: [kit.signature, ['11000-0009K', 'x', 1, 2, '']] }));
		const detected = check.classifyLocalFile(kitPath);
		assert.deepStrictEqual(detected.matches.map((m) => `${m.feed}/${m.fileName}`), ['quadratec/pricingKit_quad.xlsx']);

		// A CSV carrying the kit columns is not the kit: the seed reads an xlsx.
		const csvPath = path.join(dir, 'kit.csv');
		fs.writeFileSync(csvPath, `${kit.signature.join(',')}\n`);
		assert.deepStrictEqual(check.classifyLocalFile(csvPath).matches, []);

		const keystone = spec('keystone-ftp', 'Inventory.csv');
		const keystonePath = path.join(dir, 'SpecialOrder.csv');
		fs.writeFileSync(keystonePath, `${keystone.signature.join(',')}\nAIR LIFT,A1\n`);
		const special = check.classifyLocalFile(keystonePath);
		assert.strictEqual(special.ambiguous, false);
		assert.deepStrictEqual(special.matches.map((m) => m.fileName), ['SpecialOrder.csv']);
		assert.strictEqual(check.classifyLocalFile(keystonePath, { originalName: 'export.csv' }).ambiguous, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
