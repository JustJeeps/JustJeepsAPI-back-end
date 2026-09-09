const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createKeystoneFtpClient } = require('../../../lib/feeds/keystoneFtp');

// Fake FTP client that reproduces the production failure mode: the server
// accepts the connection, streams part of the file and then kills the data
// socket with a 426. Each attempt's behavior comes from `plan` (one entry per
// attempt; the last entry repeats if the plan runs out).
function makeFtpStub(plan) {
	const attempts = [];
	class Client {
		constructor() {
			this.ftp = {};
		}
		async access() {}
		async lastMod() {
			return new Date('2026-08-28T12:38:15.000Z');
		}
		// SIZE at the vendor, when the plan says what it should answer. Steps
		// without remoteSize answer nothing (a server without SIZE support).
		async size() {
			const step = plan[Math.min(attempts.length - 1, plan.length - 1)];
			if (step.sizeThrows) throw new Error('550 SIZE not allowed in ASCII mode');
			return step.remoteSize;
		}
		async download(writeStream, remoteFile, startAt) {
			const step = plan[Math.min(attempts.length, plan.length - 1)];
			attempts.push({ startAt });
			if (step.flushPending) {
				// What basic-ftp does on a data-socket timeout: the bytes already
				// received are still in the write stream's buffer (the file may not
				// even be open yet) when the error surfaces to the caller.
				writeStream.write(Buffer.from(step.write));
				throw new Error('Timeout (data socket)');
			}
			if (step.write) {
				await new Promise((resolve, reject) => {
					writeStream.end(Buffer.from(step.write), (error) => (error ? reject(error) : resolve()));
				});
			} else {
				await new Promise((resolve, reject) => {
					writeStream.end((error) => (error ? reject(error) : resolve()));
				});
			}
			if (step.fail) throw new Error('426 Connection closed; aborted transfer');
		}
		close() {}
	}
	return { attempts, module: { Client, enterPassiveModeIPv4: () => {} } };
}

function makeClient({ plan, env = {}, sleep, now }) {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpretry-'));
	const ftp = makeFtpStub(plan);
	const client = createKeystoneFtpClient({
		ftp: ftp.module,
		env: {
			KEYSTONE_FTP_USER: 'u',
			KEYSTONE_FTP_PASS: 'p',
			KEYSTONE_FTP_CA_PEM: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
			...env,
		},
		cacheDir,
		sleep,
		now,
	});
	return { client, ftp, localPath: path.join(cacheDir, 'SpecialOrder.csv') };
}

test('attempts that advance the file do not consume the retry budget', async () => {
	// 3 failures in a row, all with progress, against a budget of 2: the old
	// fixed budget would abort at attempt 2; counting only stalls, it finishes.
	const { client, ftp, localPath } = makeClient({
		plan: [
			{ write: '0123456789', fail: true },
			{ write: '0123456789', fail: true },
			{ write: '0123456789', fail: true },
			{ write: 'END' },
		],
		env: { KEYSTONE_FTP_MAX_ATTEMPTS: '2' },
		sleep: async () => {},
	});

	const result = await client.downloadFile('SpecialOrder.csv', localPath);

	assert.strictEqual(ftp.attempts.length, 4, 'kept going past the nominal budget');
	assert.deepStrictEqual(ftp.attempts.map((a) => a.startAt), [0, 10, 20, 30], 'resumed from the last byte each time');
	assert.strictEqual(fs.readFileSync(localPath, 'utf8'), '012345678901234567890123456789END');
	assert.ok(result.modifiedAt instanceof Date, 'still reports the vendor mtime');
});

test('consecutive attempts without progress exhaust the budget, with backoff in between', async () => {
	const sleeps = [];
	const { client, ftp, localPath } = makeClient({
		plan: [{ fail: true }],
		env: { KEYSTONE_FTP_MAX_ATTEMPTS: '2', KEYSTONE_FTP_RETRY_DELAY_MS: '7' },
		sleep: async (ms) => sleeps.push(ms),
	});

	await assert.rejects(
		() => client.downloadFile('SpecialOrder.csv', localPath),
		/without progress/
	);
	assert.strictEqual(ftp.attempts.length, 2, 'stalled attempts stop at the budget');
	assert.deepStrictEqual(sleeps, [7], 'waits between attempts, but not after the last one');
});

test('the wall-clock deadline aborts even while progress is being made', async () => {
	let clock = 0;
	const { client, localPath } = makeClient({
		plan: [{ write: '0123456789', fail: true }],
		env: { KEYSTONE_FTP_MAX_ATTEMPTS: '10', KEYSTONE_FTP_DOWNLOAD_DEADLINE_MS: '1000' },
		sleep: async () => {},
		now: () => {
			clock += 700;
			return clock;
		},
	});

	await assert.rejects(
		() => client.downloadFile('SpecialOrder.csv', localPath),
		/deadline/
	);
});

test('the resume offset waits for the previous attempt to finish writing to disk', async () => {
	// 2026-09-09: a data-socket timeout surfaced while 19KB were still being
	// flushed; the next attempt measured the file too early, resumed from the
	// wrong byte and the two streams interleaved. The whole SpecialOrder.csv
	// ended up with one broken line, which sent three seeds into OOM.
	const { client, ftp, localPath } = makeClient({
		plan: [
			{ write: '0123456789', fail: true, flushPending: true },
			{ write: 'END' },
		],
		sleep: async () => {},
	});

	await client.downloadFile('SpecialOrder.csv', localPath);

	assert.deepStrictEqual(ftp.attempts.map((a) => a.startAt), [0, 10], 'resumed from the byte that was really on disk');
	assert.strictEqual(fs.readFileSync(localPath, 'utf8'), '0123456789END');
});

test('a download that does not match the size at the vendor is discarded and redone from zero', async () => {
	const { client, ftp, localPath } = makeClient({
		plan: [
			{ write: '0123456789', remoteSize: 12 },
			{ write: '0123456789ab', remoteSize: 12 },
		],
		sleep: async () => {},
	});

	await client.downloadFile('SpecialOrder.csv', localPath);

	assert.deepStrictEqual(ftp.attempts.map((a) => a.startAt), [0, 0], 'did not resume on top of a file of the wrong size');
	assert.strictEqual(fs.readFileSync(localPath, 'utf8'), '0123456789ab');
});

test('a vendor that refuses SIZE does not block the download', async () => {
	const { client, localPath } = makeClient({
		plan: [{ write: '0123456789', sizeThrows: true }],
		sleep: async () => {},
	});

	await client.downloadFile('SpecialOrder.csv', localPath);

	assert.strictEqual(fs.readFileSync(localPath, 'utf8'), '0123456789');
});
