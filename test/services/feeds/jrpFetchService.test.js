const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runJrpFetch, createJrpFtpClient, FEED_NAME, RUN_FEED } = require('../../../services/feeds/jrpFetchService');
const { EXPECTED_COLUMNS, REMOTE_FILE } = require('../../../config/jrp');

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

// Same quoting as the real JUSJEE.csv. The size floor is lowered through the
// injected limits so the fixture can stay a few lines long.
const HEADER = EXPECTED_COLUMNS.map((column) => `"${column}"`).join(',');
const FEED = `${HEADER}\n"AlphaRex","ARX210081","210081","Wiring adapter","0","53.76","64.92"\n"Bilstein","BIL24-1","24-1","Shock","4+","100.00","120.00"\n`;
const SMALL_LIMITS = { minBytes: 10, minSizeRatio: 0.7 };

function makeFixture({ content = FEED, currentBatch = null, failUpload = false, failDownload = false, modifiedAt = null, leftoverRunning = false } = {}) {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrpfetch-'));

	const ftpClient = {
		downloads: [],
		downloadFile: async (remoteFile, localPath) => {
			ftpClient.downloads.push(remoteFile);
			if (failDownload) throw new Error('530 Login incorrect');
			fs.writeFileSync(localPath, content);
			return { modifiedAt };
		},
	};

	const store = {
		puts: [],
		buildKey: ({ feed, fileName, sha256: sha }) => `feeds/${feed}/${sha.slice(0, 8)}-${fileName}`,
		putFile: async ({ key, filePath, sizeBytes, contentType }) => {
			if (failUpload) throw new Error(`upload of ${key} failed`);
			store.puts.push({ key, sizeBytes, contentType, exists: fs.existsSync(filePath) });
		},
	};

	const registered = [];
	const catalog = {
		currentBatchCalls: [],
		getCurrentBatch: async (prisma, feed, files) => {
			catalog.currentBatchCalls.push({ feed, files });
			return currentBatch;
		},
		registerArtifacts: async (prisma, payload) => {
			registered.push(payload);
			return { batchId: payload.batchId, artifacts: payload.files };
		},
	};

	const runs = leftoverRunning ? [{ id: 1, feed: RUN_FEED, status: 'running' }] : [];
	const prisma = {
		ingestRun: {
			updateMany: async ({ where, data }) => {
				const matching = runs.filter((run) => run.feed === where.feed && run.status === where.status);
				matching.forEach((run) => Object.assign(run, data));
				return { count: matching.length };
			},
			create: async ({ data }) => {
				const run = { id: runs.length + 1, ...data };
				runs.push(run);
				return run;
			},
			update: async ({ where, data }) => {
				const run = runs.find((candidate) => candidate.id === where.id);
				Object.assign(run, data);
				return run;
			},
		},
	};

	const lastRun = () => runs[runs.length - 1];
	const run = (overrides = {}) => runJrpFetch({ ftpClient, store, prisma, catalog, cacheDir, limits: SMALL_LIMITS, ...overrides });

	return { ftpClient, store, catalog, prisma, runs, lastRun, registered, cacheDir, run };
}

test('success downloads JUSJEE.csv, uploads it, then registers one artifact and warms the cache', async () => {
	const publishedAt = new Date('2026-10-27T12:42:00Z');
	const fixture = makeFixture({ modifiedAt: publishedAt });

	const result = await fixture.run();

	assert.strictEqual(result.skipped, false);
	assert.deepStrictEqual(fixture.ftpClient.downloads, [REMOTE_FILE]);
	assert.strictEqual(fixture.store.puts.length, 1);
	assert.strictEqual(fixture.store.puts[0].contentType, 'text/csv');
	assert.strictEqual(fixture.registered.length, 1);
	const [payload] = fixture.registered;
	assert.strictEqual(payload.feed, FEED_NAME);
	assert.strictEqual(payload.source, 'ftp');
	assert.strictEqual(payload.batchId, result.batchId);
	assert.deepStrictEqual(payload.files.map((file) => file.fileName), [REMOTE_FILE]);
	assert.strictEqual(payload.files[0].sha256, sha256(FEED));
	assert.strictEqual(payload.files[0].sizeBytes, Buffer.byteLength(FEED));
	assert.strictEqual(payload.files[0].objectKey, fixture.store.puts[0].key);
	assert.strictEqual(payload.files[0].sourceModifiedAt.getTime(), publishedAt.getTime());

	const batchDir = path.join(fixture.cacheDir, FEED_NAME, result.batchId);
	assert.strictEqual(fs.readFileSync(path.join(batchDir, REMOTE_FILE), 'utf8'), FEED);
	assert.strictEqual(fs.readFileSync(path.join(batchDir, `.${REMOTE_FILE}.${sha256(FEED).slice(0, 8)}.ok`), 'utf8'), sha256(FEED));
	assert.ok(!fs.existsSync(path.join(fixture.cacheDir, 'incoming', FEED_NAME)) || fs.readdirSync(path.join(fixture.cacheDir, 'incoming', FEED_NAME)).length === 0, 'scratch dir cleaned');

	assert.strictEqual(fixture.lastRun().feed, 'jrp-ftp-fetch');
	assert.strictEqual(fixture.lastRun().sourceKind, 'ftp');
	assert.strictEqual(fixture.lastRun().sourceRef, REMOTE_FILE);
	assert.strictEqual(fixture.lastRun().status, 'success');
	assert.strictEqual(fixture.lastRun().artifactBatchId, result.batchId);
	assert.deepStrictEqual(fixture.catalog.currentBatchCalls, [{ feed: 'jrp-ftp', files: [REMOTE_FILE] }]);
});

test('a sha256 equal to the current batch is skipped-unchanged and nothing is uploaded', async () => {
	const currentBatch = { batchId: 'current-batch', artifacts: [{ fileName: REMOTE_FILE, sha256: sha256(FEED), sizeBytes: Buffer.byteLength(FEED) }] };
	const fixture = makeFixture({ currentBatch });

	const result = await fixture.run();

	assert.deepStrictEqual(result, { skipped: true, batchId: 'current-batch' });
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'skipped-unchanged');
	assert.strictEqual(fixture.lastRun().artifactBatchId, 'current-batch');
	assert.ok(!fs.existsSync(path.join(fixture.cacheDir, FEED_NAME)), 'no cache batch for a skip');
});

test('a file below the minimum size fails before uploading or cataloguing', async () => {
	const fixture = makeFixture();

	await assert.rejects(fixture.run({ limits: { ...SMALL_LIMITS, minBytes: 100_000 } }), /JUSJEE\.csv has \d+ bytes \(< minimum 100000\), truncated download\?/);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
	assert.match(fixture.lastRun().error, /truncated download/);
});

test('the default size floor is MIN_FILE_BYTES from config/jrp.js', async () => {
	const fixture = makeFixture();

	await assert.rejects(fixture.run({ limits: undefined }), /< minimum 500000/);
	assert.strictEqual(fixture.registered.length, 0);
});

test('a file that shrank below MIN_SIZE_RATIO of the current batch fails', async () => {
	const currentBatch = { batchId: 'current-batch', artifacts: [{ fileName: REMOTE_FILE, sha256: 'x'.repeat(64), sizeBytes: Buffer.byteLength(FEED) * 10 }] };
	const fixture = makeFixture({ currentBatch });

	await assert.rejects(fixture.run(), /JUSJEE\.csv shrank to \d+ bytes \(current batch has \d+, minimum 70%\)/);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
});

test('a header that is not exactly the JRP layout fails (moved column)', async () => {
	const moved = FEED.replace(HEADER, HEADER.replace('"COST","MAP"', '"MAP","COST"'));
	const fixture = makeFixture({ content: moved });

	await assert.rejects(fixture.run(), /JUSJEE\.csv has an unexpected header.*different order/);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
});

test('a header with an extra column fails too', async () => {
	const extra = FEED.replace(HEADER, `${HEADER},"UPC"`);
	const fixture = makeFixture({ content: extra });

	await assert.rejects(fixture.run(), /JUSJEE\.csv has an unexpected header.*unexpected columns: "UPC"/);
	assert.strictEqual(fixture.registered.length, 0);
});

test('a line with an odd number of quotes fails before uploading or cataloguing', async () => {
	const broken = `${FEED}"Holley","HOL1","1","Carb 9.0IN","1","10.00","12.00\n`;
	const fixture = makeFixture({ content: broken });

	await assert.rejects(fixture.run(), /JUSJEE\.csv has 1 line\(s\) with an odd number of quotes \(first at line 4\)/);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
});

test('a failed download leaves the catalog untouched and marks the run failed', async () => {
	const fixture = makeFixture({ failDownload: true });

	await assert.rejects(fixture.run(), /530 Login incorrect/);
	assert.strictEqual(fixture.store.puts.length, 0);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
	assert.ok(fixture.lastRun().finishedAt instanceof Date);
	assert.match(fixture.lastRun().error, /530 Login incorrect/);
});

test('a failed upload catalogs nothing (the previous batch stays current)', async () => {
	const fixture = makeFixture({ failUpload: true });

	await assert.rejects(fixture.run(), /upload of .*JUSJEE\.csv failed/);
	assert.strictEqual(fixture.registered.length, 0);
	assert.strictEqual(fixture.lastRun().status, 'failed');
	assert.ok(!fs.existsSync(path.join(fixture.cacheDir, FEED_NAME)), 'cache not warmed');
});

test('a leftover running fetch is marked failed before the new run starts', async () => {
	const fixture = makeFixture({ leftoverRunning: true });

	await fixture.run();

	assert.strictEqual(fixture.runs.length, 2);
	assert.strictEqual(fixture.runs[0].status, 'failed');
	assert.match(fixture.runs[0].error, /Interrupted/);
	assert.ok(fixture.runs[0].finishedAt instanceof Date);
	assert.strictEqual(fixture.runs[1].status, 'success');
});

test('createJrpFtpClient reads host, port, user and password from env: explicit FTPS, validated certificate', () => {
	const calls = [];
	const createClient = (options) => {
		calls.push(options);
		return { downloadFile: async () => ({}) };
	};
	const env = { JRP_FTP_HOST: 'ftp.example.test', JRP_FTP_USER: 'someone', JRP_FTP_PASS: 'not-a-secret' };
	const log = { info() {}, warn() {}, error() {} };

	createJrpFtpClient({ env, log, createClient });

	const [options] = calls;
	assert.strictEqual(options.secure, true);
	assert.strictEqual(options.envPrefix, 'JRP_FTP');
	assert.strictEqual(options.label, 'jrp');
	assert.strictEqual(options.host, 'ftp.example.test');
	assert.strictEqual(options.port, 21);
	assert.strictEqual(options.user, 'someone');
	assert.strictEqual(options.password, 'not-a-secret');
	assert.strictEqual(options.rejectUnauthorized, true);
	assert.strictEqual(options.env, env);
	assert.strictEqual(options.log, log);
	assert.ok(!('defaults' in options), 'no defaults object, so no undefined field reaches the attempt counter');
});

test('createJrpFtpClient honours JRP_FTP_PORT and refuses a missing host', () => {
	const calls = [];
	const createClient = (options) => {
		calls.push(options);
		return {};
	};

	createJrpFtpClient({ env: { JRP_FTP_HOST: 'h', JRP_FTP_PORT: '2121' }, createClient });
	assert.strictEqual(calls[0].port, 2121);

	assert.throws(() => createJrpFtpClient({ env: {}, createClient }), /JRP_FTP_HOST missing from the environment/);
	assert.throws(() => createJrpFtpClient({ env: { JRP_FTP_HOST: 'h', JRP_FTP_PORT: 'abc' }, createClient }), /JRP_FTP_PORT/);
});
