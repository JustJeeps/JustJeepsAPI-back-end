const test = require('node:test');
const assert = require('node:assert');

const { runJrpIngest } = require('../../../../lib/feeds/jrp/jrpIngest');
const { createWorld, createFakeDb, MATCHED_IN_FIXTURE } = require('./fakeWorld');

const VENDOR = { id: 18, name: 'JRP' };

test('a first run writes the matched rows, records the run and uploads the report', async () => {
	const { db, deps, runs, uploads, diffCalls, log } = createWorld();

	const result = await runJrpIngest(deps);

	assert.strictEqual(result.status, 'success');
	assert.strictEqual(db.vendorProducts.size, MATCHED_IN_FIXTURE);
	assert.deepStrictEqual(db.vendorProducts.get('ARX210081'), {
		product_sku: 'ALR-210081', vendor_id: 99, vendor_sku: 'ARX210081',
		vendor_cost: 53.76, vendor_inventory: 0, vendor_inventory_string: '0',
	});
	assert.deepStrictEqual(db.writes, ['vendor.create']);
	assert.strictEqual(db.vendors[0].name, 'JRP');
	assert.strictEqual(diffCalls[0].staleStrategy, 'none');
	assert.deepStrictEqual(diffCalls[0].keyCols, ['vendor_id', 'vendor_sku']);
	assert.strictEqual(diffCalls[0].staging, 'staging.vp_jrp_final');
	assert.ok(db.stage.calls.some((sql) => /INSERT INTO staging\.vp_jrp_final/.test(sql)));
	assert.ok(db.stage.closed && db.lockReleased);

	assert.strictEqual(runs.length, 1);
	assert.deepStrictEqual(runs[0].meta, { sourceKind: 'ftp-csv', sourceRef: 'JUSJEE.csv', sourceHash: 'sha-1', artifactBatchId: 'batch-1' });
	assert.strictEqual(runs[0].feed, 'jrp-ftp');
	assert.deepStrictEqual(runs[0].finished, {
		status: 'success',
		counts: { inserted: 5, updated: 0, markedStale: 0, skipped: 20 },
		sourceRowCount: 25,
	});

	assert.deepStrictEqual(uploads.map((u) => u.key), ['reports/jrp-ftp/42/unmatched.json', 'reports/jrp-ftp/42/unmatched.csv']);
	const report = JSON.parse(uploads[0].text);
	assert.strictEqual(report.runId, 42);
	assert.strictEqual(report.unmatched.length, 20);
	assert.ok(report.unmatched.every((u) => u.brandLabel && u.jrpSku && u.oemSku && u.reason === 'no-sku-match'));
	assert.strictEqual(uploads[0].contentLength, Buffer.byteLength(uploads[0].text));
	assert.ok(log.lines.some((line) => line.includes('json=reports/jrp-ftp/42/unmatched.json csv=reports/jrp-ftp/42/unmatched.csv')), 'report key is logged');
	assert.ok(log.lines.some((line) => /unmatched sample \(20 of 20\)/.test(line)));
	assert.ok(log.lines.some((line) => /map-below-cost=1/.test(line)));
});

test('the same file again is skipped by the hash gate and writes nothing', async () => {
	const world = createWorld();
	await runJrpIngest(world.deps);
	const diffCallsBefore = world.diffCalls.length;

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'skipped-unchanged');
	assert.strictEqual(world.diffCalls.length, diffCallsBefore);
	assert.deepStrictEqual(world.runs[1].finished, { status: 'skipped-unchanged', counts: { skipped: 1 } });
	assert.strictEqual(world.uploads.length, 2, 'no second report');
});

test('forced past the hash gate, a rerun on the same file changes nothing', async () => {
	const world = createWorld();
	await runJrpIngest(world.deps);
	const snapshot = JSON.stringify([...world.db.vendorProducts.entries()]);

	const result = await runJrpIngest(world.deps, { force: true });

	assert.strictEqual(result.status, 'success');
	assert.deepStrictEqual(world.runs[1].finished.counts, { inserted: 0, updated: 0, markedStale: 0, skipped: 20 });
	assert.strictEqual(JSON.stringify([...world.db.vendorProducts.entries()]), snapshot);
	assert.deepStrictEqual(world.db.writes, ['vendor.create'], 'the vendor is created once');
});

test('stale rows are listed and counted, never deleted or zeroed', async () => {
	const staleRow = { product_sku: 'ALR-OLD', vendor_id: 18, vendor_sku: 'ARXOLD', vendor_cost: 1, vendor_inventory: 3, vendor_inventory_string: '3' };
	const db = createFakeDb({ vendors: [VENDOR], vendorProducts: [staleRow] });
	const world = createWorld({ db });

	await runJrpIngest(world.deps);

	assert.deepStrictEqual(db.vendorProducts.get('ARXOLD'), staleRow);
	assert.strictEqual(world.runs[0].finished.counts.markedStale, 1);
	const report = JSON.parse(world.uploads[0].text);
	assert.deepStrictEqual(report.stale, [{ vendorSku: 'ARXOLD', productSku: 'ALR-OLD' }]);
	assert.match(world.uploads[1].text, /"stale","","ARXOLD","","ALR-OLD","missing-from-feed"/);
	assert.deepStrictEqual(db.writes, [], 'existing vendor found by name, not created');
});

test('shrink gate: far fewer rows than the last successful run fails before any write', async () => {
	const db = createFakeDb();
	db.lastSuccess = { hash: 'older', rows: 1000 };
	const world = createWorld({ db });

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /Feed shrank: 25 rows parsed vs 1000/);
	assertNothingWritten(world);
	assert.strictEqual(world.runs[0].finished.status, 'failed');
	assert.match(world.runs[0].finished.error, /Feed shrank/);
});

test('quote parity gate: a stray quote in the file fails before parsing or any write', async () => {
	const world = createWorld({ readFeed: async () => { throw new Error('readFeed must not run'); } });
	world.deps.checkQuoteParity = async () => ({ lines: 1000, oddQuoteLines: 2, firstOddQuoteLine: 101 });

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /2 line\(s\).*line 101/);
	assertNothingWritten(world);
	assert.strictEqual(world.runs[0].finished.status, 'failed');
});

test('invalid ratio gate: too many invalid rows fails before any write', async () => {
	const readFeed = async () => ({
		rowsRead: 100,
		rows: [],
		invalid: [{ jrpSku: 'A', reason: 'bad-stock' }, { jrpSku: 'B', reason: 'bad-cost' }, { jrpSku: 'C', reason: 'bad-cost' }],
	});
	const world = createWorld({ readFeed });

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /3 of 100/);
	assertNothingWritten(world);
	assert.ok(world.log.lines.some((line) => /bad-cost=2/.test(line)), 'invalid reasons are logged');
});

test('min matched gate: below the threshold fails before any write and logs both numbers', async () => {
	const world = createWorld({ env: { JRP_MIN_MATCHED: '6' } });

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assertNothingWritten(world);
	assert.ok(world.log.lines.some((line) => /5 matched, threshold 6/.test(line)));
	assert.strictEqual(world.runs[0].finished.status, 'failed');
});

test('dry run: gates and matching run, nothing is written, uploaded or recorded', async () => {
	const world = createWorld();

	const result = await runJrpIngest(world.deps, { dryRun: true });

	assert.strictEqual(result.status, 'dry-run');
	assert.strictEqual(result.counts.matched, MATCHED_IN_FIXTURE);
	assertNothingWritten(world);
	assert.strictEqual(world.runs.length, 0);
	assert.ok(world.log.lines.some((line) => /unmatched sample/.test(line)));
	assert.ok(world.log.lines.some((line) => /DRY RUN/.test(line)));
	assert.ok(world.log.lines.some((line) => /source batch=batch-1 sha=sha-1/.test(line)), 'the source is logged in dry run too');
});

test('dry run still fails on a gate', async () => {
	const world = createWorld({ env: { JRP_MIN_MATCHED: '1500' } });
	const result = await runJrpIngest(world.deps, { dryRun: true });
	assert.strictEqual(result.status, 'failed');
	assert.strictEqual(world.runs.length, 0);
});

test('a write failure marks the run failed and keeps the error', async () => {
	const world = createWorld();
	world.deps.diffApply = async () => { throw new Error('connection reset'); };

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.deepStrictEqual(world.runs[0].finished, { status: 'failed', error: 'connection reset' });
	assert.ok(world.db.stage.closed && world.db.lockReleased);
});

test('a missing catalog batch is recorded as a failed run', async () => {
	const world = createWorld();
	world.deps.materialize = async () => { throw new Error('No complete batch catalogued for feed jrp-ftp'); };

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.strictEqual(world.runs.length, 1);
	assert.match(world.runs[0].finished.error, /No complete batch/);
});

test('when the cache served another batch, the local file is hashed instead', async () => {
	const world = createWorld();
	world.deps.getCurrentBatch = async () => ({ batchId: 'batch-2', artifacts: [{ fileName: 'JUSJEE.csv', sha256: 'sha-2' }] });
	world.deps.hashFile = async () => 'sha-local';

	await runJrpIngest(world.deps);

	assert.strictEqual(world.runs[0].meta.sourceHash, 'sha-local');
	assert.strictEqual(world.runs[0].meta.artifactBatchId, 'batch-1');
});

test('another run holding the lock skips without touching anything', async () => {
	const world = createWorld();
	world.deps.lock.acquire = async () => false;

	const result = await runJrpIngest(world.deps);

	assert.strictEqual(result.status, 'skipped-locked');
	assert.strictEqual(world.runs.length, 0);
	assertNothingWritten(world);
});

function assertNothingWritten(world) {
	assert.strictEqual(world.diffCalls.length, 0, 'diffApply not called');
	assert.deepStrictEqual(world.db.writes, [], 'no vendor created');
	assert.deepStrictEqual(world.db.stage.calls, [], 'staging untouched');
	assert.deepStrictEqual(world.uploads, [], 'no report uploaded');
}

test('ambiguous matches are listed in the JSON and CSV report', async () => {
	const { deps, uploads } = createWorld();
	const loadProductsForPrefix = async (prefix) => (prefix === 'KCH'
		? [{ sku: 'KCH-0100', searchable_sku: '0100', status: 1 }, { sku: 'KCH-0100-OLD', searchable_sku: '0100', status: 0 }]
		: deps.prisma.product.findMany({ where: { sku: { startsWith: `${prefix}-` } } }));

	const result = await runJrpIngest({ ...deps, loadProductsForPrefix });

	assert.strictEqual(result.status, 'success');
	assert.strictEqual(result.counts.ambiguous, 1);
	const report = JSON.parse(uploads[0].text);
	assert.strictEqual(report.counts.ambiguous, 1);
	assert.strictEqual(report.ambiguous.length, 1);
	assert.strictEqual(report.ambiguous[0].productSku, 'KCH-0100');
	assert.deepStrictEqual(report.ambiguous[0].otherCandidates, ['KCH-0100-OLD']);
	assert.ok(uploads[1].text.split('\n').some((line) => line.startsWith('"ambiguous",') && line.endsWith('"KCH-0100","ambiguous:KCH-0100-OLD"')));
});
