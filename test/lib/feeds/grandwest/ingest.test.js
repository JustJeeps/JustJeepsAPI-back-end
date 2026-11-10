const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runGrandwestIngest } = require('../../../../lib/feeds/grandwest/ingest');
const { createWorld, createFakeDb, MATCHED_IN_FIXTURE, ROWS_IN_FIXTURE } = require('./fakeWorld');

const VENDOR = { id: 21, name: 'Grandwest' };

test('a first run writes cost and stock for the products we have, records the run and uploads the report', async () => {
	const { db, deps, runs, uploads, diffCalls, log } = createWorld();

	const result = await runGrandwestIngest(deps);

	assert.strictEqual(result.status, 'success');
	assert.strictEqual(db.vendorProducts.size, MATCHED_IN_FIXTURE);
	assert.deepStrictEqual(db.vendorProducts.get('CUR-11000'), {
		product_sku: 'CMF-11000', vendor_id: 99, vendor_sku: 'CUR-11000',
		vendor_cost: 180.2, vendor_inventory: 4, vendor_inventory_string: '4',
	});
	assert.strictEqual(db.vendorProducts.get('BDS-001402').vendor_inventory, 0, 'blank quantity is written as 0');
	assert.strictEqual(db.vendorProducts.get('BDS-002000').vendor_inventory, 6, 'fraction rounded down');
	assert.deepStrictEqual(db.writes, ['vendor.create']);
	assert.strictEqual(db.vendors[0].name, 'Grandwest');
	assert.strictEqual(diffCalls[0].staleStrategy, 'none');
	assert.deepStrictEqual(diffCalls[0].keyCols, ['vendor_id', 'vendor_sku']);
	assert.strictEqual(diffCalls[0].staging, 'staging.vp_grandwest_final');
	assert.ok(db.stage.closed && db.lockReleased);

	assert.strictEqual(runs.length, 1);
	assert.strictEqual(runs[0].feed, 'grandwest');
	assert.deepStrictEqual(runs[0].meta, { sourceKind: 'upload-csv', sourceRef: 'grandwest-price-list.csv', sourceHash: 'sha-1', artifactBatchId: 'batch-1' });
	assert.deepStrictEqual(runs[0].finished, {
		status: 'success',
		counts: { inserted: MATCHED_IN_FIXTURE, updated: 0, markedStale: 0, skipped: ROWS_IN_FIXTURE - MATCHED_IN_FIXTURE },
		sourceRowCount: ROWS_IN_FIXTURE,
	});

	assert.deepStrictEqual(uploads.map((u) => u.key), ['reports/grandwest/42/report.json', 'reports/grandwest/42/report.csv']);
	const report = JSON.parse(uploads[0].text);
	assert.deepStrictEqual(report.notCarriedByLineCode, { ACC: 1 });
	assert.deepStrictEqual(report.unmatched.map((u) => u.item), ['GOR-NOTINCATALOG']);
	assert.deepStrictEqual(report.duplicates.map((d) => [d.item, d.copies]), [['TYG-TG-BC9C8003', 2]]);
	assert.deepStrictEqual(report.invalid.map((i) => i.reason).sort(), ['bad-cost', 'item-prefix-mismatch']);
	assert.ok(log.lines.some((line) => line.includes('CUR -> CMF 1/0/0')), 'per line code summary is logged');
});

test('only products we already have are touched: Currie, repeated Items and other brands get nothing', async () => {
	const { db, deps } = createWorld();

	await runGrandwestIngest(deps);

	const written = [...db.vendorProducts.values()].map((row) => row.product_sku);
	assert.ok(!written.includes('CUR-11000'), 'a CURT price never lands on Currie');
	assert.ok(!written.includes('TGA-TG-BC9C8003'), 'an Item listed twice with two prices is not written');
	assert.ok(written.every((sku) => !sku.startsWith('ACC-') && !sku.startsWith('GOR-')));
});

test('the same file again is skipped by the hash gate and writes nothing', async () => {
	const world = createWorld();
	await runGrandwestIngest(world.deps);
	const diffCallsBefore = world.diffCalls.length;

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'skipped-unchanged');
	assert.strictEqual(world.diffCalls.length, diffCallsBefore);
	assert.strictEqual(world.uploads.length, 2, 'no second report');
});

test('forced past the hash gate, a rerun on the same file changes nothing', async () => {
	const world = createWorld();
	await runGrandwestIngest(world.deps);
	const snapshot = JSON.stringify([...world.db.vendorProducts.entries()]);

	const result = await runGrandwestIngest(world.deps, { force: true });

	assert.strictEqual(result.status, 'success');
	assert.strictEqual(world.runs[1].finished.counts.inserted, 0);
	assert.strictEqual(world.runs[1].finished.counts.updated, 0);
	assert.strictEqual(JSON.stringify([...world.db.vendorProducts.entries()]), snapshot);
	assert.deepStrictEqual(world.db.writes, ['vendor.create'], 'the vendor is created once');
});

test('a changed cost updates exactly that row', async () => {
	const existing = { product_sku: 'WTC-110002', vendor_id: 21, vendor_sku: 'WET-110002', vendor_cost: 50, vendor_inventory: 12, vendor_inventory_string: '12' };
	const world = createWorld({ db: createFakeDb({ vendors: [VENDOR], vendorProducts: [existing] }) });

	await runGrandwestIngest(world.deps);

	assert.strictEqual(world.runs[0].finished.counts.updated, 1);
	assert.strictEqual(world.db.vendorProducts.get('WET-110002').vendor_cost, 52.1);
	assert.deepStrictEqual(world.db.writes, [], 'existing vendor is reused');
});

test('rows that left the file are listed as stale, never deleted or zeroed', async () => {
	const staleRow = { product_sku: 'BDS-OLD', vendor_id: 21, vendor_sku: 'BDS-OLD', vendor_cost: 1, vendor_inventory: 3, vendor_inventory_string: '3' };
	const world = createWorld({ db: createFakeDb({ vendors: [VENDOR], vendorProducts: [staleRow] }) });

	await runGrandwestIngest(world.deps);

	assert.deepStrictEqual(world.db.vendorProducts.get('BDS-OLD'), staleRow);
	assert.strictEqual(world.runs[0].finished.counts.markedStale, 1);
	assert.ok(world.uploads[1].text.includes('"stale","","BDS-OLD","BDS-OLD","missing-from-feed"'));
});

test('a dry run reads only: no write, no vendor, no report, no run', async () => {
	const { db, deps, runs, uploads, diffCalls, log } = createWorld();

	const result = await runGrandwestIngest(deps, { dryRun: true });

	assert.strictEqual(result.status, 'dry-run');
	assert.strictEqual(result.counts.matched, MATCHED_IN_FIXTURE);
	assert.strictEqual(result.counts.notCarried, 1);
	assert.deepStrictEqual([db.vendorProducts.size, db.writes, runs, uploads, diffCalls], [0, [], [], [], []]);
	assert.ok(log.lines.some((line) => line.includes('Grandwest (to be created)')));
});

test('too few matches fails before any write and records the failure', async () => {
	const world = createWorld({ env: { GRANDWEST_MIN_MATCHED: '5000', GRANDWEST_MAX_INVALID_RATIO: '0.2' } });

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /Too few matches: 9 matched, threshold 5000/);
	assert.deepStrictEqual([world.db.vendorProducts.size, world.db.writes, world.diffCalls.length], [0, [], 0]);
	assert.strictEqual(world.runs[0].finished.status, 'failed');
	assert.ok(world.db.lockReleased && world.db.stage.closed);
});

test('a file with an unclosed quote fails before it is read', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grandwest-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'broken.csv');
	fs.writeFileSync(file, 'Item,LineCode,Desciption,UnitPrice,ListPrice,Quantity,UPC\nBDS-001401,BDS,"OPEN QUOTE,10,12,1,\n');
	let read = false;
	const world = createWorld({ file, readFeed: async () => { read = true; return { rowsRead: 0, rows: [], invalid: [] }; } });

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /unclosed quote/);
	assert.strictEqual(read, false);
});

test('more than 2% invalid rows fails before any write unless the override allows it', async () => {
	const world = createWorld({ env: { GRANDWEST_MIN_MATCHED: '9' } });

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /Too many invalid rows: 2 of 15/);
	assert.strictEqual(world.diffCalls.length, 0);
});

test('a file much smaller than the last good one fails before any write', async () => {
	const db = createFakeDb({ vendors: [VENDOR] });
	db.lastSuccess = { hash: 'older', rows: 40192 };
	const world = createWorld({ db });

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /Feed shrank: 15 rows parsed vs 40192/);
	assert.strictEqual(world.diffCalls.length, 0);
});

test('another run holding the lock makes this one skip without touching anything', async () => {
	const world = createWorld();
	world.deps.lock.acquire = async () => false;

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'skipped-locked');
	assert.deepStrictEqual([world.runs.length, world.diffCalls.length], [0, 0]);
});

test('a report upload failure after the write says a rerun is safe', async () => {
	const world = createWorld();
	world.deps.store.putStream = async () => { throw new Error('Spaces down'); };

	const result = await runGrandwestIngest(world.deps);

	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /VendorProduct was written, a rerun is safe.*Spaces down/);
});
