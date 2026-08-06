const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { createMaterializer } = require('../../../lib/feeds/materialize');

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

// The materializer narrates every download; the tests only care about the
// result, and the noise makes a failure harder to find in the output.
const SILENT = { log: () => {}, warn: () => {} };

const FEED_DEF = { name: 'ctp', files: ['CTPENT_Inventory.csv'], staleAfterHours: 24 };
const KEYSTONE_DEF = { name: 'keystone-ftp', files: ['Inventory.csv', 'SpecialOrder.csv'], staleAfterHours: 36 };

function makeFixture({ feedDef = FEED_DEF, contents = { 'CTPENT_Inventory.csv': 'sku,qty\nA,1\n' }, uploadedAt = new Date(), corruptDownload = false, storeError = null } = {}) {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedcache-'));
	const artifacts = Object.entries(contents).map(([fileName, content], index) => ({
		id: index + 1,
		fileName,
		objectKey: `feeds/${feedDef.name}/${fileName}`,
		sha256: sha256(content),
		sizeBytes: Buffer.byteLength(content),
		uploadedAt,
	}));
	const batch = { batchId: 'batch-1', uploadedAt, artifacts };

	const storeCalls = [];
	const store = {
		getObjectStream: async (key) => {
			storeCalls.push(key);
			if (storeError) throw storeError;
			const artifact = artifacts.find((a) => a.objectKey === key);
			const content = contents[artifact.fileName];
			const served = corruptDownload ? `${content}CORRUPTED` : content;
			return { body: Readable.from([Buffer.from(served)]), contentLength: Buffer.byteLength(served) };
		},
	};

	const feedsConfig = {
		getFeedByName: (name) => (name === feedDef.name ? feedDef : null),
	};
	const catalogStub = {
		getCurrentBatch: async () => batch,
	};

	const materializer = createMaterializer({
		store,
		prisma: {},
		feedsConfig,
		catalog: catalogStub,
		cacheDir,
		log: SILENT,
		now: () => new Date(uploadedAt.getTime() + 60 * 60 * 1000), // 1h after the upload
	});

	return { materializer, cacheDir, storeCalls, batch, feedDef, catalogStub };
}

test('a cache miss downloads, verifies the sha and writes the sentinel; a hit does not touch the store', async () => {
	const fixture = makeFixture();

	const first = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(fixture.storeCalls.length, 1);
	assert.strictEqual(fs.readFileSync(first.files['CTPENT_Inventory.csv'], 'utf8'), 'sku,qty\nA,1\n');
	assert.strictEqual(first.stale, false);
	assert.ok(Math.abs(first.ageHours - 1) < 0.01);

	const second = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(fixture.storeCalls.length, 1, 'a cache hit does not download again');
	assert.strictEqual(second.dir, first.dir);
});

test('an unknown feed and a feed without a batch fail with a typed code', async () => {
	const fixture = makeFixture();
	await assert.rejects(fixture.materializer.materializeFeed('does-not-exist'), (error) => error.code === 'FEED_UNKNOWN');

	fixture.catalogStub.getCurrentBatch = async () => null;
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_NO_ARTIFACT');
});

test('a corrupted download retries twice and fails with FEED_HASH_MISMATCH', async () => {
	const fixture = makeFixture({ corruptDownload: true });
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_HASH_MISMATCH');
	assert.strictEqual(fixture.storeCalls.length, 2);
	const batchDir = path.join(fixture.cacheDir, 'ctp', 'batch-1');
	assert.ok(!fs.existsSync(path.join(batchDir, 'CTPENT_Inventory.csv')), 'the corrupted file is not kept in the cache');
});

test('an old batch is marked stale and requireFresh turns into FEED_STALE', async () => {
	const uploadedAt = new Date('2026-08-01T00:00:00Z');
	const fixture = makeFixture({ uploadedAt });
	// now = uploadedAt + 1h in the fixture, so force age > threshold with a dedicated materializer
	const materializer = createMaterializer({
		store: { getObjectStream: async () => ({ body: Readable.from([Buffer.from('sku,qty\nA,1\n')]) }) },
		prisma: {},
		feedsConfig: { getFeedByName: () => FEED_DEF },
		catalog: { getCurrentBatch: async () => fixture.batch },
		cacheDir: fixture.cacheDir,
		log: SILENT,
		now: () => new Date('2026-08-03T00:00:00Z'), // 48h later (threshold 24h)
	});

	const result = await materializer.materializeFeed('ctp');
	assert.strictEqual(result.stale, true);

	await assert.rejects(materializer.materializeFeed('ctp', { requireFresh: true }), (error) => error.code === 'FEED_STALE');
});

test('Spaces down plus a complete previous batch in cache degrades to stale, no batch turns into FEED_STORE_UNAVAILABLE', async () => {
	const content = 'sku,qty\nA,1\n';
	const fixture = makeFixture({ storeError: new Error('ECONNREFUSED') });

	// Nothing in the cache: explicit failure.
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_STORE_UNAVAILABLE');

	// Pre-populate a complete old batch (file plus sentinel) and try again.
	const oldDir = path.join(fixture.cacheDir, 'ctp', 'batch-0');
	fs.mkdirSync(oldDir, { recursive: true });
	fs.writeFileSync(path.join(oldDir, 'CTPENT_Inventory.csv'), content);
	fs.writeFileSync(path.join(oldDir, `.CTPENT_Inventory.csv.${sha256(content).slice(0, 8)}.ok`), sha256(content));

	const result = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(result.stale, true, 'the fallback is always marked stale');
	assert.strictEqual(result.batchId, 'batch-0');
	assert.strictEqual(fs.readFileSync(result.files['CTPENT_Inventory.csv'], 'utf8'), content);
});

test('a multi-file feed materializes every file in the batch', async () => {
	const contents = { 'Inventory.csv': 'a\n1\n', 'SpecialOrder.csv': 'b\n2\n' };
	const fixture = makeFixture({ feedDef: KEYSTONE_DEF, contents });

	const result = await fixture.materializer.materializeFeed('keystone-ftp');
	assert.deepStrictEqual(Object.keys(result.files).sort(), ['Inventory.csv', 'SpecialOrder.csv']);
	assert.strictEqual(fs.readFileSync(result.files['SpecialOrder.csv'], 'utf8'), 'b\n2\n');
	assert.strictEqual(fixture.storeCalls.length, 2);
});

test('prune keeps only the N most recent batches', async () => {
	const fixture = makeFixture();
	const feedDir = path.join(fixture.cacheDir, 'ctp');

	// Three pre-existing old batches. The mtime is set explicitly: directories
	// created in the same millisecond tie when sorted, which made this test fail
	// once in a while depending on machine speed.
	['old-1', 'old-2', 'old-3'].forEach((name, index) => {
		const dir = path.join(feedDir, name);
		fs.mkdirSync(dir, { recursive: true });
		const when = new Date(Date.now() - (index + 1) * 60_000);
		fs.utimesSync(dir, when, when);
	});

	await fixture.materializer.materializeFeed('ctp'); // keepBatches default = 2

	const remaining = fs.readdirSync(feedDir).sort();
	assert.ok(remaining.includes('batch-1'), 'the current batch always stays');
	assert.strictEqual(remaining.length, 2, `2 batches should remain, got: ${remaining.join(', ')}`);
});
