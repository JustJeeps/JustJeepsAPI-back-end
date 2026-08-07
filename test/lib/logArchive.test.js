const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogArchive } = require('../../services/logArchive/logArchiveService');

// No network and no bucket: the store is injected and just records what it was
// handed, draining the body so we can assert on the exact bytes uploaded.
function fakeStore({ fail = false, configured = true } = {}) {
	const calls = [];
	return {
		calls,
		isConfigured: () => configured,
		putFile: async (args) => {
			if (fail) throw new Error('bucket down');
			calls.push({ ...args, body: fs.readFileSync(args.filePath, 'utf8') });
		},
		putStream: async ({ key, body, contentLength, contentType }) => {
			if (fail) throw new Error('bucket down');
			const chunks = [];
			for await (const chunk of body) chunks.push(chunk);
			const buffer = Buffer.concat(chunks);
			calls.push({ key, contentLength, contentType, body: buffer.toString('utf8'), actualBytes: buffer.length });
		},
	};
}

const ENV = { DO_SPACES_ENDPOINT: 'x', DO_SPACES_BUCKET: 'x', DO_SPACES_KEY: 'x', DO_SPACES_SECRET: 'x' };
const silent = { warn: () => {} };

function tempLog(contents) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logarchive-')), 'run.log');
	fs.writeFileSync(file, contents);
	return file;
}

const run = { command: 'seed-omix', startedAt: new Date('2026-08-07T05:45:12Z'), status: 'failed', source: 'seed-all' };

test('uploads only the slice this run appended', async () => {
	const file = tempLog('OLD RUN OUTPUT\n');
	const store = fakeStore();
	const archive = createLogArchive({ store, env: ENV, logger: silent });

	const offset = archive.currentOffset(file);
	fs.appendFileSync(file, 'NEW RUN: ENOENT omix-excel.xlsx\n');

	const result = await archive.archiveRun({ ...run, filePath: file, startOffset: offset });

	assert.equal(result.archived, true);
	assert.equal(store.calls.length, 1);
	assert.equal(store.calls[0].body, 'NEW RUN: ENOENT omix-excel.xlsx\n');
	assert.ok(!store.calls[0].body.includes('OLD RUN'), 'the previous run must not be uploaded again');
	assert.equal(store.calls[0].key, 'logs/seed-all/seed-omix/2026/08/07/20260807T054512Z-failed.log');
});

// S3 rejects a body whose length does not match ContentLength, and the header
// prepended on truncation is exactly where that can go wrong.
test('ContentLength matches the bytes actually sent, header included', async () => {
	const file = tempLog('x'.repeat(5000));
	const store = fakeStore();
	const archive = createLogArchive({ store, env: { ...ENV, LOG_ARCHIVE_MAX_BYTES: '1000' }, logger: silent });

	const result = await archive.archiveRun({ ...run, filePath: file, startOffset: 0 });

	assert.equal(result.archived, true);
	assert.equal(result.truncated, true);
	const call = store.calls[0];
	assert.equal(call.contentLength, call.actualBytes, 'declared length must equal the real body');
	assert.match(call.body, /^\[log-archive\].*4000 bytes were omitted/);
	assert.equal(call.body.endsWith('x'.repeat(1000)), true, 'the tail of the run must survive');
});

test('a run that appended nothing is not uploaded', async () => {
	const file = tempLog('unchanged\n');
	const store = fakeStore();
	const archive = createLogArchive({ store, env: ENV, logger: silent });

	const result = await archive.archiveRun({ ...run, filePath: file, startOffset: archive.currentOffset(file) });

	assert.deepEqual(result, { archived: false, reason: 'empty' });
	assert.equal(store.calls.length, 0);
});

// The whole contract: this is bookkeeping and must never fail the seed or cron
// that it is observing.
test('a bucket failure is reported, never thrown', async () => {
	const file = tempLog('');
	const store = fakeStore({ fail: true });
	const archive = createLogArchive({ store, env: ENV, logger: silent });
	fs.appendFileSync(file, 'output\n');

	const result = await archive.archiveRun({ ...run, filePath: file, startOffset: 0 });
	assert.equal(result.archived, false);
	assert.equal(result.reason, 'upload-failed');
});

test('a missing log file is reported, never thrown', async () => {
	const store = fakeStore();
	const archive = createLogArchive({ store, env: ENV, logger: silent });

	assert.deepEqual(await archive.archiveRun({ ...run, filePath: '/nope/missing.log', startOffset: 0 }), { archived: false, reason: 'empty' });
	assert.deepEqual(await archive.archiveRun({ ...run, filePath: null, startOffset: 0 }), { archived: false, reason: 'no-log-file' });
});

test('without Spaces configured it stays quiet instead of failing', async () => {
	const store = fakeStore({ configured: false });
	const archive = createLogArchive({ store, env: {}, logger: silent });

	assert.equal(archive.isConfigured(), false);
	assert.deepEqual(await archive.archiveRun({ ...run, filePath: tempLog('a'), startOffset: 0 }), { archived: false, reason: 'not-configured' });
});

test('LOG_ARCHIVE_ENABLED=false turns it off even with a working bucket', async () => {
	const store = fakeStore();
	const archive = createLogArchive({ store, env: { ...ENV, LOG_ARCHIVE_ENABLED: 'false' }, logger: silent });

	assert.equal(archive.isConfigured(), false);
	assert.equal(store.calls.length, 0);
});

test('archiveFile sends the summary whole, under its own extension', async () => {
	const file = tempLog('{"results":[]}');
	const store = fakeStore();
	const archive = createLogArchive({ store, env: ENV, logger: silent });

	const result = await archive.archiveFile({
		filePath: file,
		command: 'seed-all',
		startedAt: run.startedAt,
		status: 'failed',
		source: 'seed-all',
		extension: 'summary.json',
	});

	assert.equal(result.archived, true);
	assert.equal(store.calls[0].key, 'logs/seed-all/seed-all/2026/08/07/20260807T054512Z-failed.summary.json');
	assert.equal(store.calls[0].body, '{"results":[]}');
});
