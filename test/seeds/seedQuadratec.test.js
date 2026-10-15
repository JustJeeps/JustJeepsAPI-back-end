const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// seed-quadratec loads lib/prisma (and the ingest helpers that load it) at
// require time, so prisma is stubbed through require.cache before the seed is
// loaded. The gold sheet parser is stubbed the same way so the test never
// touches the real xlsx files. No database, no disk.

const stub = (relativePath, exports) => {
	const key = require.resolve(relativePath);
	require.cache[key] = { id: key, filename: key, loaded: true, exports };
};

const products = [];
const findManyCalls = [];
stub('../../lib/prisma', {
	product: {
		findMany: async ({ where }) => {
			findManyCalls.push(where);
			const codes = new Set(where.OR[0].quadratec_code.in);
			return products.filter((p) => codes.has(p.quadratec_code));
		},
	},
	vendorProduct: { count: async () => 0 },
	$disconnect: async () => {},
});

let feedRows = [];
stub('../../prisma/seeds/api-calls/quadratec-excel.js', () => feedRows);

const { buildQuadratecRows, quadratecSourceHash, KIT_SHEET_PATH } = require('../../prisma/seeds/seed-individual/seed-quadratec');

test('the skip gate hash is unchanged without the kit and changes with the kit digest', () => {
	const base = { fileDigest: 'csv', priceSheetDigest: 'sheet', rate: 1.55 };
	const legacy = require('crypto').createHash('sha256')
		.update('csv').update('|').update('sheet').update('|').update('1.55').digest('hex');

	assert.strictEqual(quadratecSourceHash(base), legacy, 'no kit on disk: same hash as before this change');
	assert.strictEqual(quadratecSourceHash({ ...base, kitDigest: null }), legacy);

	const withKit = quadratecSourceHash({ ...base, kitDigest: 'kit-v1' });
	assert.notStrictEqual(withKit, legacy);
	assert.strictEqual(quadratecSourceHash({ ...base, kitDigest: 'kit-v1' }), withKit, 'deterministic');
	assert.notStrictEqual(quadratecSourceHash({ ...base, kitDigest: 'kit-v2' }), withKit, 'a new kit upload is not skipped');
	assert.notStrictEqual(quadratecSourceHash({ ...base, kitDigest: 'kit-v1', rate: 1.6 }), withKit);
});

test('the kit file is looked up next to the gold sheet in api-calls', () => {
	assert.strictEqual(path.basename(KIT_SHEET_PATH), 'pricingKit_quad.xlsx');
	assert.strictEqual(path.basename(path.dirname(KIT_SHEET_PATH)), 'api-calls');
});

test('buildQuadratecRows turns a kit row (merged by the parser) into a VendorProduct candidate', async () => {
	products.length = 0;
	products.push(
		{ sku: 'QTP-11000-0009K', quadratec_code: 'QuadraTop11000-0009K', brand_name: 'QuadraTop' },
		{ sku: 'SYN-8047', quadratec_code: 'Synergy Manufacturing8047', brand_name: 'Synergy Manufacturing' },
	);
	feedRows = [
		{ quadratec_code: 'Synergy Manufacturing8047', quadratec_code_alt: 'Synergy Manufacturing16315-6512', quadratec_sku: '16315-6512', wholesalePrice: 245.7, retailPrice: 315, shippingSurcharge: null },
		// kit row as the parser emits it after the merge
		{ quadratec_code: 'QuadraTop11000-0009K', quadratec_code_alt: null, quadratec_sku: '11000-0009K', wholesalePrice: 349.98, retailPrice: 707.97, shippingSurcharge: null },
		// kit without wholesale: dropped by the existing rule
		{ quadratec_code: 'Rugged Ridge24680-0001K', quadratec_code_alt: null, quadratec_sku: '24680-0001K', wholesalePrice: null, retailPrice: 50, shippingSurcharge: null },
	];

	const result = await buildQuadratecRows();

	assert.strictEqual(result.rawCount, 3);
	const bySku = new Map(result.rowsToInsert.map((row) => [row.product_sku, row]));
	assert.deepStrictEqual([...bySku.keys()].sort(), ['QTP-11000-0009K', 'SYN-8047']);
	const kit = bySku.get('QTP-11000-0009K');
	assert.strictEqual(kit.vendor_id, 4);
	assert.strictEqual(kit.vendor_sku, 'QuadraTop11000-0009K');
	assert.strictEqual(kit.quadratec_sku, '11000-0009K');
	assert.strictEqual(kit.vendor_cost_usd, 349.98);
	assert.strictEqual(kit.vendor_retail_price_usd, 707.97);
	assert.strictEqual(result.missingProduct, 1, 'the alt code of the Synergy row has no product');
});
