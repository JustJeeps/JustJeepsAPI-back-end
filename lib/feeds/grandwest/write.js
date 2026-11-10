// Database side of the Grandwest ingest, every client injected: vendor lookup,
// product loading, stale listing and the staged diff into VendorProduct.
// Nothing here creates a Product, deletes a row or zeroes one
// (staleStrategy 'none'): only products we already have get a Grandwest row.

const { VENDOR_NAME, VENDOR_WEBSITE } = require('../../../config/grandwest');

const STAGE_RAW = 'vp_grandwest_raw';
const STAGE_FINAL = 'vp_grandwest_final';
const STAGE_BATCH = 5000;
const STAGE_RAW_DDL = `
  item TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  vendor_sku TEXT NOT NULL,
  vendor_cost DOUBLE PRECISION NOT NULL,
  vendor_inventory DOUBLE PRECISION,
  vendor_inventory_string TEXT
`;
const STAGE_COLS = ['item', 'product_sku', 'vendor_id', 'vendor_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];
const WRITE_COLS = ['product_sku', 'vendor_id', 'vendor_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];
const COMPARE_COLS = ['product_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];

// Vendor contact fields are required by the schema; there is no login, the
// file is uploaded by hand.
const VENDOR_DEFAULTS = Object.freeze({
	name: VENDOR_NAME,
	website: VENDOR_WEBSITE,
	main_contact: VENDOR_NAME,
	username: 'UPLOAD',
	password: 'NOT_STORED',
});

function createProductLoader(prisma) {
	return (prefix) => prisma.product.findMany({
		where: { sku: { startsWith: `${prefix}-` } },
		select: { sku: true, searchable_sku: true, status: true },
	});
}

function findVendor(prisma) {
	return prisma.vendor.findFirst({ where: { name: VENDOR_NAME } });
}

async function findOrCreateVendor(prisma) {
	const existing = await findVendor(prisma);
	if (existing) return { vendor: existing, created: false };
	const vendor = await prisma.vendor.create({ data: { ...VENDOR_DEFAULTS } });
	return { vendor, created: true };
}

const STALE_MISSING = 'missing-from-feed';
const STALE_COLLISION = 'feed-collision';
const STALE_REPEATED = 'repeated-in-feed';
const STALE_INVALID = 'invalid-in-feed';
const STALE_UNMATCHED = 'unmatched-in-feed';
const STALE_NOT_CARRIED = 'brand-not-carried-in-feed';

// Grandwest rows in VendorProduct whose Item is not in today's matched file.
// Listed for the report only, never deleted or zeroed. The reason says what
// to fix: an Item still in the file but held back (repeated with two prices,
// invalid, losing a collision, no longer matching our SKU or its line code no
// longer mapped) keeps an old price until someone looks.
async function listStale(prisma, vendorId, matched, { collisions = [], duplicates = [], invalid = [], unmatched = [], notCarried = [] } = {}) {
	if (!vendorId) return [];
	const inFeed = new Set(matched.map((row) => row.item));
	const heldBack = new Map([
		...notCarried.map((row) => [row.item, STALE_NOT_CARRIED]),
		...unmatched.map((row) => [row.item, STALE_UNMATCHED]),
		...invalid.map((row) => [row.item, STALE_INVALID]),
		...duplicates.map((row) => [row.item, STALE_REPEATED]),
		...collisions.map((row) => [row.item, STALE_COLLISION]),
	]);
	const current = await prisma.vendorProduct.findMany({
		where: { vendor_id: vendorId },
		select: { vendor_sku: true, product_sku: true },
	});
	return current
		.filter((row) => !inFeed.has(row.vendor_sku))
		.map((row) => ({ vendorSku: row.vendor_sku, productSku: row.product_sku, reason: heldBack.get(row.vendor_sku) || STALE_MISSING }));
}

const toStageRow = (vendorId) => (row) => ({
	item: row.item,
	product_sku: row.productSku,
	vendor_id: vendorId,
	vendor_sku: row.item,
	vendor_cost: row.cost,
	vendor_inventory: row.stock,
	vendor_inventory_string: row.stockText,
});

async function stageMatched(stage, vendorId, matched) {
	await stage.ensureTable(STAGE_RAW, STAGE_RAW_DDL);
	const rows = matched.map(toStageRow(vendorId));
	for (let offset = 0; offset < rows.length; offset += STAGE_BATCH) {
		await stage.insertBatch(STAGE_RAW, STAGE_COLS, rows.slice(offset, offset + STAGE_BATCH));
	}
	await stage.query(`
      CREATE UNLOGGED TABLE IF NOT EXISTS staging.${STAGE_FINAL} (LIKE staging.${STAGE_RAW});
      TRUNCATE staging.${STAGE_FINAL};
    `);
	await stage.query(`
      INSERT INTO staging.${STAGE_FINAL}
      SELECT DISTINCT ON (item) * FROM staging.${STAGE_RAW}
      ORDER BY item, product_sku
    `);
	const counted = await stage.query(`SELECT count(*)::int AS n FROM staging.${STAGE_FINAL}`);
	return counted.rows[0].n;
}

async function writeMatched({ stage, diffApply }, vendorId, matched) {
	if (!Number.isInteger(vendorId)) throw new Error(`Invalid Grandwest vendor id: ${vendorId}`);
	const staged = await stageMatched(stage, vendorId, matched);
	const counts = await diffApply({
		target: 'VendorProduct',
		staging: `staging.${STAGE_FINAL}`,
		keyCols: ['vendor_id', 'vendor_sku'],
		compareCols: COMPARE_COLS,
		insertCols: WRITE_COLS,
		scopeWhereSql: `t."vendor_id" = ${vendorId}`,
		staleStrategy: 'none',
	});
	return { staged, inserted: counts.inserted, updated: counts.updated };
}

module.exports = { createProductLoader, findVendor, findOrCreateVendor, listStale, writeMatched };
