const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { createMaterializer } = require('../../../lib/feeds/materialize');

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

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
		now: () => new Date(uploadedAt.getTime() + 60 * 60 * 1000), // 1h depois do upload
	});

	return { materializer, cacheDir, storeCalls, batch, feedDef, catalogStub };
}

test('cache miss baixa, verifica sha e grava sentinela; hit nao toca o store', async () => {
	const fixture = makeFixture();

	const first = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(fixture.storeCalls.length, 1);
	assert.strictEqual(fs.readFileSync(first.files['CTPENT_Inventory.csv'], 'utf8'), 'sku,qty\nA,1\n');
	assert.strictEqual(first.stale, false);
	assert.ok(Math.abs(first.ageHours - 1) < 0.01);

	const second = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(fixture.storeCalls.length, 1, 'cache hit nao redownloada');
	assert.strictEqual(second.dir, first.dir);
});

test('feed desconhecido e feed sem lote falham com codigo tipado', async () => {
	const fixture = makeFixture();
	await assert.rejects(fixture.materializer.materializeFeed('nao-existe'), (error) => error.code === 'FEED_UNKNOWN');

	fixture.catalogStub.getCurrentBatch = async () => null;
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_NO_ARTIFACT');
});

test('download corrompido tenta 2x e falha com FEED_HASH_MISMATCH', async () => {
	const fixture = makeFixture({ corruptDownload: true });
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_HASH_MISMATCH');
	assert.strictEqual(fixture.storeCalls.length, 2);
	const batchDir = path.join(fixture.cacheDir, 'ctp', 'batch-1');
	assert.ok(!fs.existsSync(path.join(batchDir, 'CTPENT_Inventory.csv')), 'arquivo corrompido nao fica no cache');
});

test('lote velho marca stale e requireFresh vira FEED_STALE', async () => {
	const uploadedAt = new Date('2026-08-01T00:00:00Z');
	const fixture = makeFixture({ uploadedAt });
	// now = uploadedAt + 1h no fixture; forca idade > threshold com um materializer proprio
	const materializer = createMaterializer({
		store: { getObjectStream: async () => ({ body: Readable.from([Buffer.from('sku,qty\nA,1\n')]) }) },
		prisma: {},
		feedsConfig: { getFeedByName: () => FEED_DEF },
		catalog: { getCurrentBatch: async () => fixture.batch },
		cacheDir: fixture.cacheDir,
		now: () => new Date('2026-08-03T00:00:00Z'), // 48h depois (threshold 24h)
	});

	const result = await materializer.materializeFeed('ctp');
	assert.strictEqual(result.stale, true);

	await assert.rejects(materializer.materializeFeed('ctp', { requireFresh: true }), (error) => error.code === 'FEED_STALE');
});

test('Spaces fora + lote anterior completo em cache degrada com stale, sem lote vira FEED_STORE_UNAVAILABLE', async () => {
	const content = 'sku,qty\nA,1\n';
	const fixture = makeFixture({ storeError: new Error('ECONNREFUSED') });

	// Sem nada em cache: falha explicita.
	await assert.rejects(fixture.materializer.materializeFeed('ctp'), (error) => error.code === 'FEED_STORE_UNAVAILABLE');

	// Pre-popula um lote antigo completo (arquivo + sentinela) e tenta de novo.
	const oldDir = path.join(fixture.cacheDir, 'ctp', 'batch-0');
	fs.mkdirSync(oldDir, { recursive: true });
	fs.writeFileSync(path.join(oldDir, 'CTPENT_Inventory.csv'), content);
	fs.writeFileSync(path.join(oldDir, `.CTPENT_Inventory.csv.${sha256(content).slice(0, 8)}.ok`), sha256(content));

	const result = await fixture.materializer.materializeFeed('ctp');
	assert.strictEqual(result.stale, true, 'fallback e sempre marcado stale');
	assert.strictEqual(result.batchId, 'batch-0');
	assert.strictEqual(fs.readFileSync(result.files['CTPENT_Inventory.csv'], 'utf8'), content);
});

test('feed multi-arquivo materializa todos os arquivos do lote', async () => {
	const contents = { 'Inventory.csv': 'a\n1\n', 'SpecialOrder.csv': 'b\n2\n' };
	const fixture = makeFixture({ feedDef: KEYSTONE_DEF, contents });

	const result = await fixture.materializer.materializeFeed('keystone-ftp');
	assert.deepStrictEqual(Object.keys(result.files).sort(), ['Inventory.csv', 'SpecialOrder.csv']);
	assert.strictEqual(fs.readFileSync(result.files['SpecialOrder.csv'], 'utf8'), 'b\n2\n');
	assert.strictEqual(fixture.storeCalls.length, 2);
});

test('prune mantem so os N lotes mais recentes', async () => {
	const fixture = makeFixture();
	const feedDir = path.join(fixture.cacheDir, 'ctp');

	// Tres lotes antigos pre-existentes.
	for (const name of ['old-1', 'old-2', 'old-3']) {
		fs.mkdirSync(path.join(feedDir, name), { recursive: true });
	}

	await fixture.materializer.materializeFeed('ctp'); // keepBatches default = 2

	const remaining = fs.readdirSync(feedDir).sort();
	assert.ok(remaining.includes('batch-1'), 'lote corrente sempre fica');
	assert.strictEqual(remaining.length, 2, `sobram 2 lotes, ficou: ${remaining.join(', ')}`);
});
