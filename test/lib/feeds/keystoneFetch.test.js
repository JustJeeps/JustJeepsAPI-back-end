const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runKeystoneFetch } = require('../../../services/feeds/keystoneFetchService');

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

// Small contents; size floors lowered through the injected env.
const INVENTORY = 'VCPN,Cost,TotalQty\nA1,10,2\n';
const SPECIAL = 'VCPN,Cost,TotalQty\nB2,20,1\n';

function makeFixture({ ftpContents = { 'Inventory.csv': INVENTORY, 'SpecialOrder.csv': SPECIAL }, failUploadOf = null, currentBatch = null } = {}) {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedfetch-'));

	const ftpClient = {
		downloads: [],
		downloadFile: async (remoteFile, localPath) => {
			ftpClient.downloads.push(remoteFile);
			fs.writeFileSync(localPath, ftpContents[remoteFile]);
		},
	};

	const store = {
		puts: [],
		buildKey: ({ feed, fileName, sha256: sha }) => `feeds/${feed}/${sha.slice(0, 8)}-${fileName}`,
		putFile: async ({ key, filePath, sizeBytes }) => {
			if (failUploadOf && key.endsWith(failUploadOf)) throw new Error(`upload of ${key} failed`);
			store.puts.push({ key, sizeBytes, exists: fs.existsSync(filePath) });
		},
	};

	const registered = [];
	const catalogStub = {
		getCurrentBatch: async () => currentBatch,
		registerArtifacts: async (prisma, payload) => {
			registered.push(payload);
			return { batchId: payload.batchId, artifacts: payload.files };
		},
	};

	const runs = [];
	const prisma = {
		ingestRun: {
			create: async ({ data }) => {
				const run = { id: runs.length + 1, ...data };
				runs.push(run);
				return run;
			},
			update: async ({ where, data }) => {
				Object.assign(runs.find((run) => run.id === where.id), data);
				return runs.find((run) => run.id === where.id);
			},
		},
	};

	const env = {
		KEYSTONE_FTP_MIN_INVENTORY_BYTES: '10',
		KEYSTONE_FTP_MIN_SPECIALORDER_BYTES: '10',
	};

	return { ftpClient, store, catalogStub, prisma, runs, registered, cacheDir, env };
}

test('happy fetch: downloads both, uploads both, catalogs one batch and warms the cache', async () => {
	const fixture = makeFixture();

	const result = await runKeystoneFetch({
		ftpClient: fixture.ftpClient,
		store: fixture.store,
		prisma: fixture.prisma,
		catalog: fixture.catalogStub,
		cacheDir: fixture.cacheDir,
		env: fixture.env,
	});

	assert.strictEqual(result.skipped, false);
	assert.deepStrictEqual(fixture.ftpClient.downloads, ['Inventory.csv', 'SpecialOrder.csv']);
	assert.strictEqual(fixture.store.puts.length, 2);
	assert.strictEqual(fixture.registered.length, 1);
	assert.strictEqual(fixture.registered[0].files.length, 2);
	assert.strictEqual(fixture.registered[0].source, 'ftp');

	// Cache warmed with sentinels in the materializer layout.
	const batchDir = path.join(fixture.cacheDir, 'keystone-ftp', result.batchId);
	assert.ok(fs.existsSync(path.join(batchDir, 'Inventory.csv')));
	assert.ok(fs.existsSync(path.join(batchDir, `.SpecialOrder.csv.${sha256(SPECIAL).slice(0, 8)}.ok`)));

	const run = fixture.runs[0];
	assert.strictEqual(run.feed, 'keystone-ftp-fetch');
	assert.strictEqual(run.status, 'success');
	assert.strictEqual(run.artifactBatchId, result.batchId);
});

test('a file below the minimum size aborts BEFORE uploading or cataloging', async () => {
	const fixture = makeFixture({ ftpContents: { 'Inventory.csv': 'VCPN\n', 'SpecialOrder.csv': SPECIAL } });
	fixture.env.KEYSTONE_FTP_MIN_INVENTORY_BYTES = '1000';

	await assert.rejects(
		runKeystoneFetch({ ftpClient: fixture.ftpClient, store: fixture.store, prisma: fixture.prisma, catalog: fixture.catalogStub, cacheDir: fixture.cacheDir, env: fixture.env }),
		/truncated download/
	);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.runs[0].status, 'failed');
});

test('a header without VCPN aborts', async () => {
	const fixture = makeFixture({ ftpContents: { 'Inventory.csv': 'foo,bar\n1,2\n', 'SpecialOrder.csv': SPECIAL } });

	await assert.rejects(
		runKeystoneFetch({ ftpClient: fixture.ftpClient, store: fixture.store, prisma: fixture.prisma, catalog: fixture.catalogStub, cacheDir: fixture.cacheDir, env: fixture.env }),
		/VCPN/
	);
	assert.strictEqual(fixture.registered.length, 0);
});

test('hashes equal to the current batch become a skip with no upload at all', async () => {
	const currentBatch = {
		batchId: 'current-batch',
		artifacts: [
			{ fileName: 'Inventory.csv', sha256: sha256(INVENTORY) },
			{ fileName: 'SpecialOrder.csv', sha256: sha256(SPECIAL) },
		],
	};
	const fixture = makeFixture({ currentBatch });

	const result = await runKeystoneFetch({ ftpClient: fixture.ftpClient, store: fixture.store, prisma: fixture.prisma, catalog: fixture.catalogStub, cacheDir: fixture.cacheDir, env: fixture.env });

	assert.strictEqual(result.skipped, true);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.runs[0].status, 'skipped-unchanged');
	assert.strictEqual(fixture.runs[0].artifactBatchId, 'current-batch');
});

test('a download that shrinks against the current batch is rejected (a truncated one would pass the fixed floor)', async () => {
	// The current batch is much bigger: the new download has a size the floor finds
	// plausible, but it is half of the previous one, and with staleStrategy delete
	// that would erase rows.
	const currentBatch = {
		batchId: 'current-batch',
		artifacts: [
			{ fileName: 'Inventory.csv', sha256: 'x'.repeat(64), sizeBytes: 100 },
			{ fileName: 'SpecialOrder.csv', sha256: 'y'.repeat(64), sizeBytes: 1000 },
		],
	};
	const fixture = makeFixture({ currentBatch });

	await assert.rejects(
		runKeystoneFetch({ ftpClient: fixture.ftpClient, store: fixture.store, prisma: fixture.prisma, catalog: fixture.catalogStub, cacheDir: fixture.cacheDir, env: fixture.env }),
		/shrank to/
	);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
});

test('a failed upload of the second file catalogs NOTHING (the previous batch stays current)', async () => {
	const fixture = makeFixture({ failUploadOf: 'SpecialOrder.csv' });

	await assert.rejects(
		runKeystoneFetch({ ftpClient: fixture.ftpClient, store: fixture.store, prisma: fixture.prisma, catalog: fixture.catalogStub, cacheDir: fixture.cacheDir, env: fixture.env }),
		/upload of .*SpecialOrder\.csv failed/
	);
	assert.strictEqual(fixture.store.puts.length, 1, 'Inventory uploaded, SpecialOrder failed');
	assert.strictEqual(fixture.registered.length, 0, 'catalog untouched');
	assert.strictEqual(fixture.runs[0].status, 'failed');
});
