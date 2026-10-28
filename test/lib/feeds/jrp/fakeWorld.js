// In-memory stand-ins for everything runJrpIngest touches (catalog, Spaces,
// IngestRun, staging tables, VendorProduct), so the orchestration is tested
// end to end without a database. Not a test file (no .test.js suffix).

const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'JUSJEE-sample.csv');

// Five fixture rows have a product in this catalog (one per brand listed).
const CATALOG = [
	{ sku: 'ALR-210081', searchable_sku: '210081', status: 1 },
	{ sku: 'AIR-100-262', searchable_sku: '100-262', status: 1 },
	{ sku: 'KCH-0100', searchable_sku: '0100', status: 1 },
	{ sku: 'BIL-10-255605', searchable_sku: '10-255605', status: 1 },
	{ sku: 'ESP-1.2101G', searchable_sku: '1.2101G', status: 1 },
];
const MATCHED_IN_FIXTURE = 5;

const COMPARE = ['product_sku', 'vendor_cost', 'vendor_inventory', 'vendor_inventory_string'];

function createFakeDb({ vendors = [], vendorProducts = [] } = {}) {
	const db = { vendors: [...vendors], vendorProducts: new Map(vendorProducts.map((row) => [row.vendor_sku, row])), writes: [] };
	db.prisma = {
		vendor: {
			findFirst: async ({ where }) => db.vendors.find((v) => v.name === where.name) || null,
			create: async ({ data }) => {
				db.writes.push('vendor.create');
				const vendor = { id: 99, ...data };
				db.vendors.push(vendor);
				return vendor;
			},
		},
		// No delete/update methods on purpose: calling one throws.
		vendorProduct: {
			findMany: async ({ where }) => [...db.vendorProducts.values()]
				.filter((row) => row.vendor_id === where.vendor_id)
				.map(({ vendor_sku, product_sku }) => ({ vendor_sku, product_sku })),
		},
		ingestRun: { findFirst: async () => (db.lastSuccess ? { sourceRowCount: db.lastSuccess.rows } : null) },
		product: {
			findMany: async ({ where }) => CATALOG.filter((p) => p.sku.startsWith(where.sku.startsWith)),
		},
	};
	return db;
}

function createStage(db) {
	const tables = {};
	const stage = {
		calls: [],
		tables,
		ensureTable: async (name) => { stage.calls.push(`ensure ${name}`); tables[name] = []; },
		insertBatch: async (name, cols, rows) => {
			tables[name].push(...rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]]))));
			return rows.length;
		},
		query: async (sql) => {
			stage.calls.push(sql.trim().split('\n')[0]);
			if (sql.includes('DISTINCT ON (jrpsku)')) {
				const seen = new Map();
				for (const row of tables.vp_jrp_raw) if (!seen.has(row.jrpsku)) seen.set(row.jrpsku, row);
				tables.vp_jrp_final = [...seen.values()];
			}
			if (sql.includes('count(*)')) return { rows: [{ n: tables.vp_jrp_final.length }] };
			return { rows: [] };
		},
		close: async () => { stage.closed = true; },
	};
	db.stage = stage;
	return stage;
}

function createDiffApply(db) {
	const calls = [];
	const diffApply = async (options) => {
		calls.push(options);
		if (options.staleStrategy !== 'none') throw new Error('JRP must never delete or zero stale rows');
		let inserted = 0;
		let updated = 0;
		for (const row of db.stage.tables.vp_jrp_final) {
			const existing = db.vendorProducts.get(row.vendor_sku);
			const next = Object.fromEntries(options.insertCols.map((c) => [c, row[c]]));
			if (!existing) inserted += 1;
			else if (options.compareCols.some((c) => existing[c] !== row[c])) updated += 1;
			else continue;
			db.vendorProducts.set(row.vendor_sku, next);
		}
		return { inserted, updated, stale: 0 };
	};
	return { diffApply, calls };
}

function createRuns(db) {
	const runs = [];
	let nextId = 41;
	const ingestRun = {
		startRun: async (feed, meta) => {
			nextId += 1;
			const run = { id: nextId, feed, meta, finished: null };
			runs.push(run);
			return {
				id: run.id,
				finish: async (result) => {
					run.finished = result;
					if (result.status === 'success') db.lastSuccess = { hash: meta.sourceHash, rows: result.sourceRowCount };
				},
			};
		},
		isUnchanged: async (feed, hash) => Boolean(db.lastSuccess && db.lastSuccess.hash === hash),
	};
	return { ingestRun, runs };
}

function silentLog() {
	const lines = [];
	const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
	return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function createWorld({ db = createFakeDb(), env = { JRP_MIN_MATCHED: String(MATCHED_IN_FIXTURE) }, sha = 'sha-1', readFeed } = {}) {
	createStage(db);
	const { diffApply, calls: diffCalls } = createDiffApply(db);
	const { ingestRun, runs } = createRuns(db);
	const uploads = [];
	const log = silentLog();
	const deps = {
		prisma: db.prisma,
		store: {
			putStream: async (object) => { uploads.push({ ...object, text: object.body.toString('utf8') }); },
		},
		materialize: async () => ({ files: { 'JUSJEE.csv': FIXTURE }, batchId: 'batch-1' }),
		getCurrentBatch: async () => ({ batchId: 'batch-1', artifacts: [{ fileName: 'JUSJEE.csv', sha256: sha }] }),
		hashFile: async () => { throw new Error('hashFile must not run when the catalog artifact is current'); },
		ingestRun,
		lock: { acquire: async () => true, release: async () => { db.lockReleased = true; } },
		stage: db.stage,
		diffApply,
		vendorsPrefix: require('../../../../prisma/seeds/hard-code_data/vendors_prefix'),
		env,
		now: () => new Date('2026-10-27T13:50:00Z'),
		log,
		...(readFeed ? { readFeed } : {}),
	};
	return { db, deps, runs, uploads, diffCalls, log };
}

module.exports = { createWorld, createFakeDb, MATCHED_IN_FIXTURE, FIXTURE };
