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

async function runDownload({ env, store, cacheDir }) {
	const ftp = makeFtpStub();
	const client = createKeystoneFtpClient({ ftp: ftp.module, env, store, cacheDir });
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
	const originalWarn = console.warn;
	console.warn = (msg) => warnings.push(String(msg));
	try {
		const call = await runDownload({ env: { ...baseEnv }, store: { isConfigured: () => false }, cacheDir });
		assert.strictEqual(call.secureOptions.ca, undefined);
	} finally {
		console.warn = originalWarn;
	}
	assert.ok(warnings.some((w) => w.includes('intermediate CA')), 'warns that the CA was not found');
});
