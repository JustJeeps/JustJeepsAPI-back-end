const test = require('node:test');
const assert = require('node:assert');

const { runSeedTdot } = require('../../prisma/seeds/seed-individual/seed-tdot');

const silent = { info() {}, warn() {}, error() {} };

function makePrisma({ products = [], existing = [], updateCount = 1, insertCount = 1, lastRun = null } = {}) {
	const raw = [];
	return {
		raw,
		product: { findMany: async () => products },
		ingestRun: { findFirst: async () => lastRun },
		competitorProduct: { findMany: async () => existing },
		$executeRawUnsafe(sql, ...params) {
			const op = { sql, params };
			raw.push(op);
			return Object.assign(Promise.resolve(sql.includes('UPDATE "CompetitorProduct"') ? updateCount : insertCount), op);
		},
		$transaction: async (ops) => Promise.all(ops),
	};
}

function makeStartRun() {
	const runs = [];
	return {
		runs,
		startRun: async (feed, opts) => {
			const run = { feed, opts, finished: null, id: 42, finish: async (outcome) => { run.finished = outcome; } };
			runs.push(run);
			return run;
		},
	};
}

const rows = [
	{ tdot_price: 343.98, tdot_code: 'Bestop 52401-11', sku: '52401-11', brand: 'Bestop', product_url: 'https://t/1' },
	{ tdot_price: 12, tdot_code: 'Nope 1', sku: '1', brand: 'Nope', product_url: null },
	{ tdot_price: NaN, tdot_code: 'Bestop 0', sku: '0', brand: 'Bestop', product_url: null },
];
const products = [{ sku: 'BST-52401-11', tdot_code: 'Bestop 52401-11' }];
const payload = { source: 'tdot', items: [{ tdotCode: 'Bestop 52401-11' }], collection: { requests: 10, failedRequests: 0, matched: 1, unmatched: 2, invalidCount: 0, partial: false } };

test('writes the matched rows through the unchanged upsert, records the run and reports counts', async () => {
	// the one matched row already exists: the UPDATE touches it, the INSERT adds nothing
	const prisma = makePrisma({ products, existing: [{ competitor_sku: 'Bestop 52401-11' }], updateCount: 1, insertCount: 0 });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => ({ rows, payload, snapshotPath: '/tmp/s.json' }) };

	const result = await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent });

	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(result.counts, { inserted: 0, updated: 1, skipped: 0 }, 'skipped = rows that were already up to date');
	assert.strictEqual(prisma.raw.length, 2, 'one UPDATE and one INSERT batch');
	const update = prisma.raw[0].sql;
	assert.match(update, /updated_at = CURRENT_TIMESTAMP/);
	assert.match(update, /IS DISTINCT FROM/);
	assert.deepStrictEqual(prisma.raw[0].params, [4, JSON.stringify([{ product_sku: 'BST-52401-11', competitor_sku: 'Bestop 52401-11', competitor_price: 343.98, product_url: 'https://t/1' }])]);
	assert.match(prisma.raw[1].sql, /INSERT INTO "CompetitorProduct"/);
	assert.strictEqual(runs[0].feed, 'tdot');
	assert.strictEqual(runs[0].opts.sourceKind, 'api');
	assert.strictEqual(runs[0].finished.status, 'success');
	assert.deepStrictEqual(runs[0].finished.counts, { inserted: 0, updated: 1, skipped: 0 });
	assert.strictEqual(runs[0].finished.sourceRowCount, 1, 'the matched rows the run wrote');
	assert.strictEqual(result.summary.unmatched, 2);
});

test('a partial collection still writes, is recorded as partial and exits 2 so the cron e-mail fires', async () => {
	const prisma = makePrisma({ products });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => ({ rows, payload: { ...payload, collection: { ...payload.collection, partial: true } }, snapshotPath: null }) };
	const result = await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent });
	assert.strictEqual(result.exitCode, 2);
	assert.strictEqual(prisma.raw.length, 2, 'the rows are written');
	assert.strictEqual(runs[0].finished.status, 'partial');
});

test('a run that matches far fewer products than the last successful run is refused before writing', async () => {
	const prisma = makePrisma({ products, lastRun: { id: 7, sourceRowCount: 1000 } });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => ({ rows, payload, snapshotPath: null }) };
	const result = await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent, matchDropRatio: 0.8 });
	assert.strictEqual(result.exitCode, 1);
	assert.strictEqual(prisma.raw.length, 0);
	assert.match(runs[0].finished.error, /MATCH_DROP/);
});

test('a run with no matched rows is refused whatever the source', async () => {
	const prisma = makePrisma({ products });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => ({ rows: [], payload: null, snapshotPath: null }) };
	const result = await runSeedTdot({ prisma, source, startRun, argv: ['--from-snapshot', '/tmp/empty.json'], logger: silent });
	assert.strictEqual(result.exitCode, 1);
	assert.match(runs[0].finished.error, /NO_ROWS/);
});

test('two of our products with the same tdot_code resolve deterministically: active first, then sku', async () => {
	const twins = [{ sku: 'K&N-123', tdot_code: 'K&N 123', status: 0 }, { sku: 'KDA-123', tdot_code: 'K&N 123', status: 1 }];
	const prisma = makePrisma({ products: twins });
	const { startRun } = makeStartRun();
	const source = { fetchRows: async () => ({ rows: [{ tdot_price: 5, tdot_code: 'K&N 123', sku: '123', brand: 'K&N', product_url: null }], payload: null, snapshotPath: null }) };
	await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent });
	assert.strictEqual(JSON.parse(prisma.raw[0].params[1])[0].product_sku, 'KDA-123');
});

test('the snapshot is archived after a real run and a failure to record the outcome is logged', async () => {
	const prisma = makePrisma({ products });
	const archived = [];
	const errors = [];
	const logger = { info() {}, warn() {}, error: (m) => errors.push(m) };
	const run = { id: 42, finish: async () => { throw new Error('db gone'); } };
	const source = { fetchRows: async () => ({ rows, payload, snapshotPath: '/tmp/s.json' }) };
	const result = await runSeedTdot({ prisma, source, startRun: async () => run, argv: [], logger, archive: async (args) => { archived.push(args); return { archived: true, key: 'k' }; } });
	assert.strictEqual(result.exitCode, 0);
	assert.deepStrictEqual(archived[0].filePath, '/tmp/s.json');
	assert.strictEqual(archived[0].status, 'success');
	assert.ok(errors.some((m) => /could not record the run outcome/.test(m)));
});

test('--dry-run matches and reports but writes nothing', async () => {
	const prisma = makePrisma({ products });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async (opts) => { assert.strictEqual(opts.dryRun, true); return { rows, payload, snapshotPath: null }; } };
	const result = await runSeedTdot({ prisma, source, startRun, argv: ['--dry-run'], logger: silent });
	assert.strictEqual(result.exitCode, 0);
	assert.strictEqual(prisma.raw.length, 0);
	assert.strictEqual(runs[0].opts.startedBy, 'dry-run');
	assert.strictEqual(runs[0].finished.status, 'dry-run');
	assert.deepStrictEqual(result.counts, { inserted: 0, updated: 0, skipped: 0 });
	assert.strictEqual(result.wouldWrite, 1);
});

test('--from-snapshot hands the file to the source', async () => {
	const prisma = makePrisma({ products });
	const { startRun } = makeStartRun();
	let seen = null;
	const source = { fetchRows: async (opts) => { seen = opts; return { rows: [], payload: null, snapshotPath: null }; } };
	await runSeedTdot({ prisma, source, startRun, argv: ['--from-snapshot', '/tmp/snap.json', '--dry-run'], logger: silent });
	assert.strictEqual(seen.fromSnapshot, '/tmp/snap.json');
});

test('a failure records the run as failed and returns exit code 1 instead of swallowing it', async () => {
	const prisma = makePrisma({ products });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => { throw Object.assign(new Error('TDOT_CANARY_FAILED: REQUEST_FAILED_RATIO (30 of 100 requests failed)'), { code: 'TDOT_CANARY_FAILED', failures: [{ code: 'REQUEST_FAILED_RATIO', message: '30 of 100 requests failed' }] }); } };
	const result = await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent });
	assert.strictEqual(result.exitCode, 1);
	assert.strictEqual(runs[0].finished.status, 'failed');
	assert.match(runs[0].finished.error, /REQUEST_FAILED_RATIO/);
	assert.match(runs[0].finished.error, /TDOT_CANARY_FAILED/, 'the message travels with the code');
	assert.strictEqual(runs[0].finished.error.split('TDOT_CANARY_FAILED').length, 2, 'the code is not repeated when the message already carries it');
	assert.strictEqual(prisma.raw.length, 0);
});

test('requiring the module does not run the seed', () => {
	assert.strictEqual(typeof runSeedTdot, 'function');
});

test('a row whose price and link did not change counts as skipped, not as written', async () => {
	const prisma = makePrisma({ products, existing: [{ competitor_sku: 'Bestop 52401-11' }], updateCount: 0, insertCount: 0 });
	const { startRun, runs } = makeStartRun();
	const source = { fetchRows: async () => ({ rows, payload, snapshotPath: null }) };
	const result = await runSeedTdot({ prisma, source, startRun, argv: [], logger: silent });
	assert.deepStrictEqual(result.counts, { inserted: 0, updated: 0, skipped: 1 });
	assert.strictEqual(runs[0].finished.status, 'success');
});
