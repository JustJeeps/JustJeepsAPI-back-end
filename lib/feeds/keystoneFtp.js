// Keystone FTPS client (ftp.ekeystone.com) for fetching the Inventory.csv /
// SpecialOrder.csv feeds. The download loop with byte resume was ported from
// prisma/seeds/api-calls/keystone-ftp.js:53-98, but with credentials ALWAYS
// coming from env (KEYSTONE_FTP_USER/PASS already exist as a secret in the
// deploy; the legacy script had the credentials hardcoded).
//
// basic-ftp comes in as a parameter so the tests run without network.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const basicFtp = require('basic-ftp');

const DEFAULT_HOST = 'ftp.ekeystone.com';
const DEFAULT_PORT = 990; // implicit FTPS
// The Keystone server sends ONLY the leaf certificate, without the
// intermediate (GeoTrust TLS RSA CA G1, from DigiCert), so Node cannot build
// the chain on its own and fails with "unable to verify the first
// certificate". The right fix is not to turn verification off: it is to supply
// the missing intermediate, keeping signature and hostname validated.
//
// The file is NOT kept in the repository. Resolution order:
//   1. KEYSTONE_FTP_CA_PEM     PEM content (or base64) straight from the env
//   2. KEYSTONE_FTP_CA_FILE    absolute path outside the project
//   3. private object in the Space (KEYSTONE_FTP_CA_OBJECT_KEY, default below),
//      downloaded once and kept in the local feed cache
const DEFAULT_CA_OBJECT_KEY = 'certs/keystone-ftp-ca.pem';
const SOCKET_TIMEOUT_MS = 180000;
// The Keystone server drops long transfers with a 426 in the middle of the
// ~460MB file; the byte resume recovers, so an attempt that advanced the file
// must not count against this budget (on 2026-08-28 a degraded evening burned
// 12 attempts at ~86% of the file). The budget counts CONSECUTIVE attempts
// without progress; the deadline below is the absolute stop.
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_DOWNLOAD_DEADLINE_MS = 45 * 60 * 1000;

// Looks for the PEM in the env or in the private bucket. Never in the repository.
async function loadExtraCa({ env, store, cacheDir, log = console }) {
	const inline = env.KEYSTONE_FTP_CA_PEM;
	if (inline) {
		return inline.includes('BEGIN CERTIFICATE')
			? inline
			: Buffer.from(inline, 'base64').toString('utf8');
	}

	if (env.KEYSTONE_FTP_CA_FILE && fs.existsSync(env.KEYSTONE_FTP_CA_FILE)) {
		return fs.readFileSync(env.KEYSTONE_FTP_CA_FILE, 'utf8');
	}

	const objectKey = env.KEYSTONE_FTP_CA_OBJECT_KEY || DEFAULT_CA_OBJECT_KEY;
	const cachePath = path.join(cacheDir, 'certs', path.basename(objectKey));
	if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

	if (!store || !store.isConfigured || !store.isConfigured()) return null;
	try {
		const { body } = await store.getObjectStream(objectKey);
		const chunks = [];
		for await (const chunk of body) chunks.push(chunk);
		const pem = Buffer.concat(chunks).toString('utf8');
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, pem);
		return pem;
	} catch (error) {
		log.warn(`⚠️ Could not read ${objectKey} from the bucket: ${error.message}`);
		return null;
	}
}

function createKeystoneFtpClient({
	ftp = basicFtp,
	env = process.env,
	store = null,
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	// Injected so tests can keep the library quiet: raw console output from
	// the code under test interleaves with `node --test`'s serialized stdout
	// channel and the runner dies with "Unable to deserialize cloned data".
	log = console,
} = {}) {
	const host = env.KEYSTONE_FTP_HOST || DEFAULT_HOST;
	const port = Number(env.KEYSTONE_FTP_PORT || DEFAULT_PORT);
	const user = env.KEYSTONE_FTP_USER || '';
	const password = env.KEYSTONE_FTP_PASS || '';
	const maxAttempts = Math.max(1, Number(env.KEYSTONE_FTP_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS));
	const retryDelayMs = Math.max(0, Number(env.KEYSTONE_FTP_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS));
	const downloadDeadlineMs = Math.max(1, Number(env.KEYSTONE_FTP_DOWNLOAD_DEADLINE_MS || DEFAULT_DOWNLOAD_DEADLINE_MS));
	// Certificate VALIDATED by default. Without this, an attacker on the network
	// path terminates the FTPS session with any certificate, captures the
	// credentials and returns a forged Inventory/SpecialOrder, which would pass
	// the size/header gates and enter the catalog as the current batch (the
	// consumer runs with staleStrategy "delete"). Explicit opt-out is for
	// diagnostics only.
	const rejectUnauthorized = env.KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED !== 'false';

	// System roots + the intermediate the server omits. Passing only the
	// intermediate in `ca` would REPLACE Node's root list and break validation,
	// which is why both go together. Resolved once per process.
	let cachedBundle = null;
	const caBundle = async () => {
		if (cachedBundle !== null) return cachedBundle;
		const extra = await loadExtraCa({ env, store, cacheDir, log });
		cachedBundle = extra ? [...tls.rootCertificates, extra] : undefined;
		if (!extra) {
			log.warn('⚠️ Keystone intermediate CA not found (env or bucket), TLS validation is going to fail');
		}
		return cachedBundle;
	};

	const assertConfigured = () => {
		if (!user || !password) {
			throw new Error('KEYSTONE_FTP_USER/KEYSTONE_FTP_PASS missing from the environment');
		}
	};

	// basic-ftp hands the error (or the success) back before the write stream
	// has flushed what the data socket delivered; on a timeout the file may not
	// even be open yet. Measuring the file before the descriptor is closed
	// resumes from the wrong byte and leaves two writers appending to the same
	// file: on 2026-09-09 that interleaved 19KB, stitched two records into one
	// line with an odd number of quotes, and every CSV reader downstream buffered
	// the remaining 368MB until the kernel killed it. Nothing reads or measures
	// the file until the stream has closed.
	const settleStream = (stream) =>
		new Promise((resolve) => {
			if (!stream || stream.closed) return resolve();
			stream.once('close', resolve);
			stream.once('error', () => {});
			if (!stream.destroyed && !stream.writableEnded) stream.end();
		});

	// The vendor's own byte count is the cheapest proof that the resumes added
	// up to the whole file. A server without SIZE (or refusing it in this mode)
	// is not an error; a mismatch throws the download away so the next attempt
	// starts from zero instead of resuming on top of a broken file.
	const verifyRemoteSize = async (client, remoteFile, localPath) => {
		if (typeof client.size !== 'function') return;
		let remoteSize;
		try {
			remoteSize = await client.size(remoteFile);
		} catch (error) {
			log.warn(`⚠️ Could not read the size of ${remoteFile} at the vendor, skipping the size check: ${error.message}`);
			return;
		}
		if (!Number.isFinite(remoteSize) || remoteSize <= 0) return;
		const localSize = fs.statSync(localPath).size;
		if (localSize !== remoteSize) {
			fs.rmSync(localPath, { force: true });
			throw new Error(`${remoteFile} has ${localSize} bytes locally but ${remoteSize} at the vendor, discarding the download`);
		}
	};

	async function downloadFile(remoteFile, localPath) {
		assertConfigured();
		let lastError = null;
		let attempt = 0;
		let stalledAttempts = 0;
		const deadline = now() + downloadDeadlineMs;

		while (stalledAttempts < maxAttempts) {
			if (now() >= deadline) {
				throw new Error(
					`Could not download ${remoteFile}: deadline of ${downloadDeadlineMs}ms exceeded after ${attempt} attempts (last error: ${lastError?.message})`
				);
			}

			attempt += 1;
			const client = new ftp.Client();
			client.ftp.socketTimeout = SOCKET_TIMEOUT_MS;
			client.prepareTransfer = ftp.enterPassiveModeIPv4;

			// Resume from the byte where the previous download stopped (SpecialOrder ~460MB).
			let startAt = 0;
			if (fs.existsSync(localPath)) {
				startAt = fs.statSync(localPath).size;
				if (startAt > 0) log.log(`⏩ Resuming ${remoteFile} from byte ${startAt}`);
			}

			let writeStream = null;
			try {
				await client.access({
					host,
					port,
					user,
					password,
					secure: 'implicit',
					secureOptions: { rejectUnauthorized, ca: await caBundle(), servername: host },
					timeout: SOCKET_TIMEOUT_MS,
				});

				// When the vendor last wrote the file, which is the only way to
				// tell today's export from yesterday's: the fetch runs on a
				// schedule that sometimes beats the vendor to it, and a download
				// of the previous day's file succeeds exactly like a fresh one.
				// Not every server answers MDTM, so a failure here is not one.
				let modifiedAt = null;
				try {
					modifiedAt = await client.lastMod(remoteFile);
				} catch (error) {
					log.warn(`⚠️ Could not read the date of ${remoteFile} at the vendor: ${error.message}`);
				}

				writeStream = fs.createWriteStream(localPath, { flags: startAt > 0 ? 'a' : 'w' });
				log.log(`📥 Downloading ${remoteFile} (attempt ${attempt})${modifiedAt ? `, published ${modifiedAt.toISOString()}` : ''}...`);
				await client.download(writeStream, remoteFile, startAt);
				await settleStream(writeStream);
				await verifyRemoteSize(client, remoteFile, localPath);
				client.close();
				return { modifiedAt };
			} catch (error) {
				lastError = error;
				client.close();
				await settleStream(writeStream);

				// An attempt that advanced the file is the resume doing its job,
				// not a reason to give up: only consecutive stalls burn the budget.
				const sizeNow = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
				stalledAttempts = sizeNow > startAt ? 0 : stalledAttempts + 1;
				log.warn(
					`⚠️ Download of ${remoteFile} failed (attempt ${attempt}, ${stalledAttempts}/${maxAttempts} without progress): ${error.message}`
				);
				if (stalledAttempts < maxAttempts && retryDelayMs > 0) await sleep(retryDelayMs);
			}
		}

		throw new Error(
			`Could not download ${remoteFile}: ${maxAttempts} consecutive attempts without progress, ${attempt} in total (last error: ${lastError?.message})`
		);
	}

	return { downloadFile };
}

module.exports = { createKeystoneFtpClient };
