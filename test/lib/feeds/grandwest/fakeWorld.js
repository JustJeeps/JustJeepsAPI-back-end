// In-memory stand-ins for everything runGrandwestIngest touches (catalog,
// Spaces, IngestRun, staging tables, VendorProduct), so the orchestration is
// tested end to end without a database. Not a test file (no .test.js suffix).
// Same shape as test/lib/feeds/jrp/fakeWorld.js.

const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'grandwest-sample.csv');
const FILE_NAME = 'grandwest-price-list.csv';

// Products we already have. CUR-11000 is Currie: the CURT row of the fixture
// (CUR-11000) must land on CMF-11000, never on it. TGA-TG-BC9C8003 exists but
// its Item is listed twice with two prices, so it must get nothing.
const CATALOG = [
	{ sku: 'BDS-001401', searchable_sku: '001401', status: 1 },
	{ sku: 'BDS-001402', searchable_sku: '001402', status: 1 },
	{ sku: 'BDS-002000', searchable_sku: '002000', status: 1 },
	{ sku: 'WTC-110002', searchable_sku: '110002', status: 1 },
	{ sku: 'CUR-11000', searchable_sku: '11000', status: 1 },
	{ sku: 'CMF-11000', searchable_sku: '11000', status: 1 },
	{ sku: 'SB-2820', searchable_sku: '2820', status: 1 },
	{ sku: 'DEZ-DZ16203', searchable_sku: 'DZ16203', status: 1 },
	{ sku: 'PLC-001247R03', searchable_sku: '001247R03', status: 1 },
	{ sku: 'FAD-FOC-TG-7W96', searchable_sku: 'FOC-TG-7W96', status: 1 },
	{ sku: 'TGA-TG-BC9C8003', searchable_sku: 'TG-BC9C8003', status: 1 },
];
const MATCHED_IN_FIXTURE = 9;
const ROWS_IN_FIXTURE = 15;

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
		// No delete/update/create methods on purpose: calling one throws.
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
			if (sql.includes('DISTINCT ON (item)')) {
				const seen = new Map();
				for (const row of tables.vp_grandwest_raw) if (!seen.has(row.item)) seen.set(row.item, row);
				tables.vp_grandwest_final = [...seen.values()];
			}
			if (sql.includes('count(*)')) return { rows: [{ n: tables.vp_grandwest_final.length }] };
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
		if (options.staleStrategy !== 'none') throw new Error('Grandwest must never delete or zero stale rows');
		let inserted = 0;
		let updated = 0;
		for (const row of db.stage.tables.vp_grandwest_final) {
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

function createWorld({ db = createFakeDb(), env = { GRANDWEST_MIN_MATCHED: String(MATCHED_IN_FIXTURE), GRANDWEST_MAX_INVALID_RATIO: '0.2' }, sha = 'sha-1', readFeed, file = FIXTURE } = {}) {
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
		materialize: async () => ({ files: { [FILE_NAME]: file }, batchId: 'batch-1' }),
		getCurrentBatch: async () => ({ batchId: 'batch-1', artifacts: [{ fileName: FILE_NAME, sha256: sha }] }),
		hashFile: async () => { throw new Error('hashFile must not run when the catalog artifact is current'); },
		ingestRun,
		lock: { acquire: async () => true, release: async () => { db.lockReleased = true; } },
		stage: db.stage,
		diffApply,
		vendorsPrefix: require('../../../../prisma/seeds/hard-code_data/vendors_prefix'),
		env,
		now: () => new Date('2026-11-10T15:00:00Z'),
		log,
		...(readFeed ? { readFeed } : {}),
	};
	return { db, deps, runs, uploads, diffCalls, log };
}

module.exports = { createWorld, createFakeDb, MATCHED_IN_FIXTURE, ROWS_IN_FIXTURE, FIXTURE };
