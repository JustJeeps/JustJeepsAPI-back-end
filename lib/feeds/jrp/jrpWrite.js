// Database side of the JRP ingest, every client injected: vendor lookup,
// product loading, stale listing and the staged diff into VendorProduct.
// Nothing here deletes or zeroes a row (staleStrategy 'none').

const { VENDOR_NAME, VENDOR_WEBSITE } = require('../../../config/jrp');

const STAGE_RAW = 'vp_jrp_raw';
const STAGE_FINAL = 'vp_jrp_final';
const STAGE_BATCH = 5000;
const STAGE_RAW_DDL = `
  jrpsku TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  vendor_sku TEXT NOT NULL,
  vendor_cost DOUBLE PRECISION NOT NULL,
  vendor_inventory DOUBLE PRECISION,
  vendor_inventory_string TEXT
`;
const STAGE_COLS = ['jrpsku', 'product_sku', 'vendor_id', 'vendor_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];
const WRITE_COLS = ['product_sku', 'vendor_id', 'vendor_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];
const COMPARE_COLS = ['product_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];

// Vendor contact fields are required by the schema; JRP's FTP login lives in
// the environment, never here.
const VENDOR_DEFAULTS = Object.freeze({
	name: VENDOR_NAME,
	website: VENDOR_WEBSITE,
	main_contact: VENDOR_NAME,
	username: 'FTP',
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

// Rows of this vendor in VendorProduct whose vendor_sku is not in the matched
// feed. Listed for the report only. A row that lost a feed collision today
// (it is in the file, but another row was written for its product) gets its
// own reason: it needs a manual cleanup, it is not missing.
async function listStale(prisma, vendorId, matched, collisions = []) {
	if (!vendorId) return [];
	const inFeed = new Set(matched.map((row) => row.jrpSku));
	const lost = new Set(collisions.map((row) => row.jrpSku));
	const current = await prisma.vendorProduct.findMany({
		where: { vendor_id: vendorId },
		select: { vendor_sku: true, product_sku: true },
	});
	return current
		.filter((row) => !inFeed.has(row.vendor_sku))
		.map((row) => ({ vendorSku: row.vendor_sku, productSku: row.product_sku, reason: lost.has(row.vendor_sku) ? STALE_COLLISION : STALE_MISSING }));
}

const toStageRow = (vendorId) => (row) => ({
	jrpsku: row.jrpSku,
	product_sku: row.productSku,
	vendor_id: vendorId,
	vendor_sku: row.jrpSku,
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
      SELECT DISTINCT ON (jrpsku) * FROM staging.${STAGE_RAW}
      ORDER BY jrpsku, product_sku
    `);
	const counted = await stage.query(`SELECT count(*)::int AS n FROM staging.${STAGE_FINAL}`);
	return counted.rows[0].n;
}

async function writeMatched({ stage, diffApply }, vendorId, matched) {
	if (!Number.isInteger(vendorId)) throw new Error(`Invalid JRP vendor id: ${vendorId}`);
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
