const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFtpsClient } = require('../../../lib/feeds/ftpsClient');
const { explicitTlsConnect } = require('../../../lib/feeds/explicitTlsConnect');

const PEM = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n';
const AIA_PEM = '-----BEGIN CERTIFICATE-----\nAIA\n-----END CERTIFICATE-----\n';
const CHAIN_ERROR = 'unable to verify the first certificate (control socket)';
const quietLog = { log() {}, warn() {}, error() {} };
const passiveMode = () => {};

// Fake basic-ftp module. Each attempt follows `plan` (the last entry repeats):
// { access: 'error message' } fails the login, { write, fail } streams bytes
// and optionally kills the transfer with a 426 afterwards.
function makeFtp(plan) {
	const accessCalls = [];
	const clients = [];
	const downloads = [];
	const stepFor = (index) => plan[Math.min(index, plan.length - 1)];
	class Client {
		constructor() {
			this.ftp = {};
			clients.push(this);
		}
		async access(options) {
			accessCalls.push(options);
			const step = stepFor(accessCalls.length - 1);
			if (step.access) throw new Error(step.access);
		}
		async lastMod() {
			return new Date('2026-10-27T12:42:00.000Z');
		}
		async download(writeStream, remoteFile, startAt) {
			const step = stepFor(accessCalls.length - 1);
			downloads.push({ remoteFile, startAt });
			await new Promise((resolve, reject) => {
				writeStream.end(Buffer.from(step.write || ''), (error) => (error ? reject(error) : resolve()));
			});
			if (step.fail) throw new Error('426 Connection closed; aborted transfer');
		}
		close() {}
	}
	return { accessCalls, clients, downloads, module: { Client, enterPassiveModeIPv4: passiveMode } };
}

function makeClient({ plan, env = {}, options = {}, now, sleep = async () => {}, fetchIntermediate }) {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftps-'));
	const ftp = makeFtp(plan);
	const client = createFtpsClient({
		secure: true,
		envPrefix: 'JRP_FTP',
		label: 'jrp',
		host: 'ftp.example.test',
		port: 21,
		user: 'u',
		password: 'p',
		ftp: ftp.module,
		env: { JRP_FTP_CA_PEM: PEM, JRP_FTP_RETRY_DELAY_MS: '0', ...env },
		cacheDir,
		sleep,
		now,
		fetchIntermediate: fetchIntermediate || (async () => assert.fail('must not fetch')),
		log: quietLog,
		...options,
	});
	const localPath = path.join(cacheDir, 'JUSJEE.csv');
	return { client, ftp, cacheDir, localPath, download: () => client.downloadFile('JUSJEE.csv', localPath) };
}

test('explicit mode connects with AUTH TLS (secure: true) on the given port', async () => {
	const run = makeClient({ plan: [{ write: 'a,b\n' }] });
	await run.download();
	const [access] = run.ftp.accessCalls;
	assert.strictEqual(access.secure, true);
	assert.strictEqual(access.host, 'ftp.example.test');
	assert.strictEqual(access.port, 21);
	assert.strictEqual(access.secureOptions.servername, 'ftp.example.test');
	assert.strictEqual(access.secureOptions.rejectUnauthorized, true, 'validated by default');
});

test('implicit mode connects with secure: implicit', async () => {
	const run = makeClient({ plan: [{ write: 'a,b\n' }], options: { secure: 'implicit', port: 990 } });
	await run.download();
	assert.strictEqual(run.ftp.accessCalls[0].secure, 'implicit');
	assert.strictEqual(run.ftp.accessCalls[0].port, 990);
});

test('an unknown secure mode is refused up front', () => {
	assert.throws(() => makeClient({ plan: [{}], options: { secure: false } }), /secure must be true or 'implicit'/);
});

test('every attempt uses passive mode over IPv4', async () => {
	const run = makeClient({ plan: [{ write: '0123', fail: true }, { write: 'END' }] });
	await run.download();
	assert.strictEqual(run.ftp.clients.length, 2);
	for (const client of run.ftp.clients) assert.strictEqual(client.prepareTransfer, passiveMode);
});

test('a dropped transfer resumes from the byte already on disk', async () => {
	const run = makeClient({ plan: [{ write: '0123456789', fail: true }, { write: 'END' }] });
	const result = await run.download();
	assert.deepStrictEqual(run.ftp.downloads.map((d) => d.startAt), [0, 10]);
	assert.strictEqual(fs.readFileSync(run.localPath, 'utf8'), '0123456789END');
	assert.ok(result.modifiedAt instanceof Date);
});

test('env names derive from envPrefix and win over the defaults passed in', async () => {
	const fromDefault = makeClient({ plan: [{ fail: true }], options: { defaults: { maxAttempts: 3 } } });
	await assert.rejects(fromDefault.download(), /3 consecutive attempts without progress/);
	assert.strictEqual(fromDefault.ftp.accessCalls.length, 3);

	const fromEnv = makeClient({
		plan: [{ fail: true }],
		env: { JRP_FTP_MAX_ATTEMPTS: '2' },
		options: { defaults: { maxAttempts: 3 } },
	});
	await assert.rejects(fromEnv.download(), /2 consecutive attempts without progress/);
	assert.ok(fromEnv.ftp.accessCalls[0].secureOptions.ca.includes(PEM), 'JRP_FTP_CA_PEM goes into the bundle');
});

test('missing credentials name the env variables of the prefix', async () => {
	const run = makeClient({ plan: [{}], options: { user: '' } });
	await assert.rejects(run.download(), /JRP_FTP_USER\/JRP_FTP_PASS missing/);
	assert.strictEqual(run.ftp.accessCalls.length, 0);
});

test('explicit mode reads the leaf for AIA through the AUTH TLS adapter and retries with it', async () => {
	const lookups = [];
	const run = makeClient({
		plan: [{ access: CHAIN_ERROR }, { write: 'a,b\n' }],
		fetchIntermediate: async (target) => {
			lookups.push(target);
			return { pem: AIA_PEM, subject: 'RapidSSL TLS RSA CA G1', fingerprint: 'f00d', leafIssuer: 'RapidSSL TLS RSA CA G1' };
		},
	});
	await run.download();
	assert.strictEqual(lookups.length, 1);
	assert.strictEqual(lookups[0].tlsConnect, explicitTlsConnect);
	assert.strictEqual(lookups[0].host, 'ftp.example.test');
	assert.strictEqual(lookups[0].port, 21);
	assert.ok(run.ftp.accessCalls[1].secureOptions.ca.includes(AIA_PEM));
	assert.strictEqual(run.ftp.accessCalls[1].secureOptions.rejectUnauthorized, true);
});

test('a rejected certificate chain surfaces an error naming the vendor and its CA env', async () => {
	const run = makeClient({
		plan: [{ access: CHAIN_ERROR }],
		fetchIntermediate: async () => {
			throw new Error('could not fetch the intermediate "Other CA" for ftp.example.test: HTTP 404');
		},
	});
	await assert.rejects(run.download(), /jrp FTP certificate chain cannot be verified.*Other CA.*JRP_FTP_CA_OBJECT_KEY/);
	assert.strictEqual(run.ftp.accessCalls.length, 1);
});

test('other certificate errors are not retried through AIA and end the run with the cause', async () => {
	const run = makeClient({ plan: [{ access: 'certificate has expired (control socket)' }], env: { JRP_FTP_MAX_ATTEMPTS: '2' } });
	await assert.rejects(run.download(), /2 consecutive attempts without progress.*certificate has expired/);
});

test('the deadline stops the loop even while the file keeps growing', async () => {
	let clock = 0;
	const run = makeClient({
		plan: [{ write: '0123456789', fail: true }],
		env: { JRP_FTP_MAX_ATTEMPTS: '10' },
		options: { defaults: { downloadDeadlineMs: 1000 } },
		now: () => {
			clock += 700;
			return clock;
		},
	});
	await assert.rejects(run.download(), /deadline of 1000ms exceeded after 1 attempts/);
	assert.strictEqual(run.ftp.accessCalls.length, 1);
});

test('without a pinned CA the warning points to AIA instead of predicting a TLS failure', async () => {
	const warnings = [];
	const missing = Object.assign(new Error('UnknownError'), { $metadata: { httpStatusCode: 404 } });
	const run = makeClient({
		plan: [{ write: 'a,b\n' }],
		env: { JRP_FTP_CA_PEM: '' },
		options: {
			store: { isConfigured: () => true, getObjectStream: async () => { throw missing; } },
			log: { ...quietLog, warn: (msg) => warnings.push(String(msg)) },
		},
	});
	await run.download();
	assert.deepStrictEqual(warnings, ['⚠️ jrp intermediate CA not found (env or bucket), it will be fetched through AIA if the server omits it']);
});
