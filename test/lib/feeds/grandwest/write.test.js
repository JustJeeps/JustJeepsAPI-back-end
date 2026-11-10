const test = require('node:test');
const assert = require('node:assert');

const write = require('../../../../lib/feeds/grandwest/write');

const GRANDWEST_ID = 21;
const matched = [
	{ item: 'BDS-001401', productSku: 'BDS-001401', cost: 235.48, stock: 3, stockText: '3' },
	{ item: 'CUR-11000', productSku: 'CMF-11000', cost: 180.2, stock: 4, stockText: '4' },
];

function captureStage() {
	const inserted = [];
	const sql = [];
	return {
		inserted,
		sql,
		ensureTable: async () => {},
		insertBatch: async (name, cols, rows) => { inserted.push(...rows.map((row) => ({ table: name, ...row }))); },
		query: async (text) => { sql.push(text); return { rows: [{ n: inserted.length }] }; },
	};
}

test('every staged row carries the Grandwest vendor id and goes to Grandwest staging tables only', async () => {
	const stage = captureStage();

	await write.writeMatched({ stage, diffApply: async () => ({ inserted: 0, updated: 0 }) }, GRANDWEST_ID, matched);

	assert.deepStrictEqual([...new Set(stage.inserted.map((row) => row.vendor_id))], [GRANDWEST_ID]);
	assert.deepStrictEqual([...new Set(stage.inserted.map((row) => row.table))], ['vp_grandwest_raw']);
	const tables = stage.sql.join('\n').match(/staging\.\w+/g);
	assert.ok(tables.every((name) => name.startsWith('staging.vp_grandwest_')), tables.join(', '));
});

test('the diff is keyed and scoped by vendor: another vendor with the same vendor_sku is out of reach', async () => {
	const calls = [];
	const diffApply = async (options) => { calls.push(options); return { inserted: 0, updated: 0 }; };

	await write.writeMatched({ stage: captureStage(), diffApply }, GRANDWEST_ID, matched);

	const [options] = calls;
	assert.deepStrictEqual(options.keyCols, ['vendor_id', 'vendor_sku'], 'the UPDATE joins on vendor_id too');
	assert.strictEqual(options.scopeWhereSql, `t."vendor_id" = ${GRANDWEST_ID}`);
	assert.strictEqual(options.staleStrategy, 'none');
	assert.strictEqual(options.staging, 'staging.vp_grandwest_final');
});

test('a vendor id that is not an integer never reaches the database', async () => {
	await assert.rejects(write.writeMatched({ stage: captureStage(), diffApply: async () => assert.fail('no write') }, undefined, matched), /Invalid Grandwest vendor id/);
	await assert.rejects(write.writeMatched({ stage: captureStage(), diffApply: async () => assert.fail('no write') }, '21 OR 1=1', matched), /Invalid Grandwest vendor id/);
});

test('the stale listing and the vendor lookup only ever read Grandwest', async () => {
	const queries = [];
	const prisma = {
		vendor: { findFirst: async (query) => { queries.push(query); return { id: GRANDWEST_ID, name: 'Grandwest' }; } },
		vendorProduct: { findMany: async (query) => { queries.push(query); return []; } },
	};

	await write.findVendor(prisma);
	await write.listStale(prisma, GRANDWEST_ID, matched);

	assert.deepStrictEqual(queries[0].where, { name: 'Grandwest' });
	assert.deepStrictEqual(queries[1].where, { vendor_id: GRANDWEST_ID });
});
