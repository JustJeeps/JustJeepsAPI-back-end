const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { createKeystoneFtpClient } = require('../../../lib/feeds/keystoneFtp');

const PEM = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n';

// Fake FTP client: keeps the access() options so we can inspect the TLS config.
function makeFtpStub() {
	const calls = [];
	class Client {
		constructor() {
			this.ftp = {};
		}
		async access(options) {
			calls.push(options);
			throw new Error('stop here: we only want to inspect access()');
		}
		close() {}
	}
	return { calls, module: { Client, enterPassiveModeIPv4: () => {} } };
}

const baseEnv = { KEYSTONE_FTP_USER: 'u', KEYSTONE_FTP_PASS: 'p', KEYSTONE_FTP_MAX_ATTEMPTS: '1' };

const quietLog = { log() {}, warn() {}, error() {} };

async function runDownload({ env, store, cacheDir, log = quietLog }) {
	const ftp = makeFtpStub();
	const client = createKeystoneFtpClient({ ftp: ftp.module, env, store, cacheDir, log });
	await client.downloadFile('Inventory.csv', path.join(cacheDir, 'out.csv')).catch(() => {});
	return ftp.calls[0];
}

test('the certificate is validated by default and the opt-out is explicit', async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpca-'));
	const on = await runDownload({ env: { ...baseEnv, KEYSTONE_FTP_CA_PEM: PEM }, cacheDir });
	assert.strictEqual(on.secureOptions.rejectUnauthorized, true);
	assert.strictEqual(on.secureOptions.servername, 'ftp.ekeystone.com');

	const off = await runDownload({
		env: { ...baseEnv, KEYSTONE_FTP_CA_PEM: PEM, KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED: 'false' },
		cacheDir,
	});
	assert.strictEqual(off.secureOptions.rejectUnauthorized, false);
});

test('the CA comes from the env, as PEM or base64, alongside the system roots', async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpca-'));

	const fromPem = await runDownload({ env: { ...baseEnv, KEYSTONE_FTP_CA_PEM: PEM }, cacheDir });
	assert.ok(fromPem.secureOptions.ca.includes(PEM), 'the PEM from the env goes into the bundle');
	assert.ok(fromPem.secureOptions.ca.length > 1, 'the system roots are still present');

	const fromB64 = await runDownload({
		env: { ...baseEnv, KEYSTONE_FTP_CA_PEM: Buffer.from(PEM).toString('base64') },
		cacheDir,
	});
	assert.ok(fromB64.secureOptions.ca.includes(PEM), 'base64 is decoded');
});

test('without the env, fetches the private object from the bucket and caches it', async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpca-'));
	const requested = [];
	const store = {
		isConfigured: () => true,
		getObjectStream: async (key) => {
			requested.push(key);
			return { body: Readable.from([Buffer.from(PEM)]) };
		},
	};

	const first = await runDownload({ env: { ...baseEnv }, store, cacheDir });
	assert.deepStrictEqual(requested, ['certs/keystone-ftp-ca.pem']);
	assert.ok(first.secureOptions.ca.includes(PEM));
	assert.ok(fs.existsSync(path.join(cacheDir, 'certs', 'keystone-ftp-ca.pem')), 'cached it');

	// Second run (fresh process) uses the cache without touching the bucket.
	await runDownload({ env: { ...baseEnv }, store, cacheDir });
	assert.strictEqual(requested.length, 1, 'the cache avoids another download');
});

test('without the env and without the bucket, warns and continues with the system roots only', async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpca-'));
	const warnings = [];
	const log = { ...quietLog, warn: (msg) => warnings.push(String(msg)) };
	const call = await runDownload({ env: { ...baseEnv }, store: { isConfigured: () => false }, cacheDir, log });
	assert.strictEqual(call.secureOptions.ca, undefined);
	assert.ok(warnings.some((w) => w.includes('intermediate CA')), 'warns that the CA was not found');
});

// --- Chain recovery through the certificate's AIA URL (Keystone changed CA on
// 2026-10-10 and the pinned intermediate stopped matching).

const AIA_PEM = '-----BEGIN CERTIFICATE-----\nAIA\n-----END CERTIFICATE-----\n';
const CHAIN_ERROR = 'unable to verify the first certificate (control socket)';

// access() follows `plan` (one entry per call; the last repeats): an error
// message to throw, or 'ok' to connect and serve a tiny file.
function makeScriptedFtp(plan) {
	const calls = [];
	class Client {
		constructor() {
			this.ftp = {};
		}
		async access(options) {
			calls.push(options);
			const step = plan[Math.min(calls.length - 1, plan.length - 1)];
			if (step !== 'ok') throw new Error(step);
		}
		async lastMod() {
			return null;
		}
		async download(writeStream) {
			await new Promise((resolve) => writeStream.end(Buffer.from('a,b\n'), resolve));
		}
		close() {}
	}
	return { calls, module: { Client, enterPassiveModeIPv4: () => {} } };
}

function aiaClient({ plan, fetchIntermediate, cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpaia-')) }) {
	const ftp = makeScriptedFtp(plan);
	const client = createKeystoneFtpClient({
		ftp: ftp.module,
		env: { ...baseEnv, KEYSTONE_FTP_CA_PEM: PEM, KEYSTONE_FTP_MAX_ATTEMPTS: '12', KEYSTONE_FTP_RETRY_DELAY_MS: '0' },
		cacheDir,
		log: quietLog,
		fetchIntermediate,
	});
	return { ftp, client, cacheDir, download: () => client.downloadFile('Inventory.csv', path.join(cacheDir, 'out.csv')) };
}

test('a broken chain fetches the intermediate once, stores it and retries with it in the bundle', async () => {
	const lookups = [];
	const run = aiaClient({
		plan: [CHAIN_ERROR, 'ok'],
		fetchIntermediate: async (target) => {
			lookups.push(target);
			return { pem: AIA_PEM, subject: 'New CA', fingerprint: 'abc123', leafIssuer: 'New CA' };
		},
	});

	await run.download();

	assert.deepStrictEqual(lookups, [{ host: 'ftp.ekeystone.com', port: 990, servername: 'ftp.ekeystone.com' }]);
	assert.strictEqual(run.ftp.calls.length, 2);
	assert.ok(!run.ftp.calls[0].secureOptions.ca.includes(AIA_PEM));
	assert.ok(run.ftp.calls[1].secureOptions.ca.includes(AIA_PEM), 'the retry trusts the fetched intermediate');
	assert.ok(run.ftp.calls[1].secureOptions.ca.includes(PEM), 'the configured intermediate stays');
	assert.strictEqual(run.ftp.calls[1].secureOptions.rejectUnauthorized, true);
	assert.strictEqual(fs.readFileSync(path.join(run.cacheDir, 'certs', 'aia', 'abc123.pem'), 'utf8'), AIA_PEM);
});

test('an intermediate fetched by an earlier run is loaded without fetching again', async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftpaia-'));
	fs.mkdirSync(path.join(cacheDir, 'certs', 'aia'), { recursive: true });
	fs.writeFileSync(path.join(cacheDir, 'certs', 'aia', 'abc123.pem'), AIA_PEM);

	const run = aiaClient({
		cacheDir,
		plan: ['ok'],
		fetchIntermediate: async () => assert.fail('must not fetch'),
	});
	await run.download();
	assert.ok(run.ftp.calls[0].secureOptions.ca.includes(AIA_PEM));
});

test('when the intermediate cannot be fetched the run stops at once naming the new CA', async () => {
	const run = aiaClient({
		plan: [CHAIN_ERROR],
		fetchIntermediate: async () => {
			throw new Error('could not fetch the intermediate "Some New CA" for ftp.ekeystone.com: HTTP 404');
		},
	});
	await assert.rejects(run.download(), /certificate chain cannot be verified.*Some New CA.*KEYSTONE_FTP_CA_OBJECT_KEY/);
	assert.strictEqual(run.ftp.calls.length, 1, 'no 12 identical attempts');
});

test('when the fetched intermediate does not fix the chain the run stops after one retry', async () => {
	let lookups = 0;
	const run = aiaClient({
		plan: [CHAIN_ERROR],
		fetchIntermediate: async () => {
			lookups += 1;
			return { pem: AIA_PEM, subject: 'New CA', fingerprint: 'abc123', leafIssuer: 'New CA' };
		},
	});
	await assert.rejects(run.download(), /still cannot be verified/);
	assert.strictEqual(lookups, 1);
	assert.strictEqual(run.ftp.calls.length, 2);
});

test('other TLS errors (an expired certificate) do not go to AIA', async () => {
	const run = aiaClient({
		plan: ['certificate has expired (control socket)'],
		fetchIntermediate: async () => assert.fail('must not fetch'),
	});
	await assert.rejects(run.download(), /12 consecutive attempts without progress.*certificate has expired/);
});
