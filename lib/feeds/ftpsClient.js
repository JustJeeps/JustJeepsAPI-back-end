// Generic FTPS download client with byte resume, a retry budget that counts
// only attempts without progress, an absolute deadline, a vendor SIZE check
// and recovery of an intermediate certificate the server omits (AIA).
//
// Extracted from lib/feeds/keystoneFtp.js (implicit FTPS) so explicit FTPS
// vendors (AUTH TLS, for example JRP) reuse the same loop. Connection details
// come in as options; tuning env names derive from `envPrefix`:
//   <PREFIX>_MAX_ATTEMPTS, <PREFIX>_RETRY_DELAY_MS, <PREFIX>_DOWNLOAD_DEADLINE_MS,
//   <PREFIX>_CA_PEM, <PREFIX>_CA_FILE, <PREFIX>_CA_OBJECT_KEY (lib/feeds/ftpsCa.js).
// The env wins over `defaults`, which wins over the built-in values below.
//
// basic-ftp comes in as a parameter so the tests run without network.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const basicFtp = require('basic-ftp');
const { isMissingIntermediateError, fetchIntermediateViaAia } = require('./aiaIntermediate');
const { explicitTlsConnect } = require('./explicitTlsConnect');
const { loadConfiguredCa, loadAiaCas, saveAiaCa } = require('./ftpsCa');

const SECURE_MODES = new Set([true, 'implicit']);
const SOCKET_TIMEOUT_MS = 180000;
// Long transfers get dropped with a 426 halfway; the byte resume recovers, so
// an attempt that advanced the file must not count against this budget. The
// budget counts CONSECUTIVE attempts without progress; the deadline is the
// absolute stop.
const BUILT_IN_DEFAULTS = Object.freeze({
	maxAttempts: 10,
	retryDelayMs: 5000,
	downloadDeadlineMs: 45 * 60 * 1000,
});

function resolveSettings({ env, envPrefix, label, defaults }) {
	const merged = { ...BUILT_IN_DEFAULTS, caObjectKey: `certs/${label.toLowerCase()}-ftp-ca.pem`, ...defaults };
	return {
		maxAttempts: Math.max(1, Number(env[`${envPrefix}_MAX_ATTEMPTS`] || merged.maxAttempts)),
		retryDelayMs: Math.max(0, Number(env[`${envPrefix}_RETRY_DELAY_MS`] || merged.retryDelayMs)),
		downloadDeadlineMs: Math.max(1, Number(env[`${envPrefix}_DOWNLOAD_DEADLINE_MS`] || merged.downloadDeadlineMs)),
		caObjectKey: merged.caObjectKey,
	};
}

function assertOptions({ secure, envPrefix, label, host }) {
	if (!SECURE_MODES.has(secure)) throw new Error(`secure must be true or 'implicit', got ${JSON.stringify(secure)}`);
	if (!envPrefix || !label || !host) throw new Error('envPrefix, label and host are required');
}

// System roots + the intermediates the server omits. Passing only the
// intermediates in `ca` would REPLACE Node's root list and break validation,
// which is why both go together. Resolved once per process, and again after
// an AIA fetch adds a file.
function createCaBundle({ env, envPrefix, label, caObjectKey, store, cacheDir, log }) {
	let cached = null;
	const get = async () => {
		if (cached !== null) return cached;
		const configured = await loadConfiguredCa({ env, envPrefix, defaultObjectKey: caObjectKey, store, cacheDir, log });
		const extras = [configured, ...loadAiaCas(cacheDir)].filter(Boolean);
		cached = extras.length > 0 ? [...tls.rootCertificates, ...extras] : undefined;
		if (extras.length === 0) {
			log.warn(`⚠️ ${label} intermediate CA not found (env or bucket), it will be fetched through AIA if the server omits it`);
		}
		return cached;
	};
	const reset = () => {
		cached = null;
	};
	return { get, reset };
}

// Called once per process when the chain cannot be built. Retrying the same
// bundle is pointless, so either the AIA fetch fixes it or the run stops with
// the name of the CA the vendor moved to.
function createIntermediateRecovery({ secure, host, port, envPrefix, label, cacheDir, caBundle, fetchIntermediate, log }) {
	let attempted = false;
	// Explicit FTPS starts in plain text, so the leaf is read after AUTH TLS.
	const target = secure === true ? { host, port, servername: host, tlsConnect: explicitTlsConnect } : { host, port, servername: host };
	return async (tlsError) => {
		if (attempted) {
			throw new Error(`${label} FTP certificate chain still cannot be verified after fetching its intermediate: ${tlsError.message}`);
		}
		attempted = true;
		let found;
		try {
			found = await fetchIntermediate(target);
		} catch (error) {
			throw new Error(
				`${label} FTP certificate chain cannot be verified (${tlsError.message}); ${error.message}. ` +
					`${label} probably changed its certificate: put the new intermediate in the bucket (${envPrefix}_CA_OBJECT_KEY).`
			);
		}
		saveAiaCa(cacheDir, found);
		caBundle.reset();
		log.log(`🔐 Fetched ${label} intermediate "${found.subject}" via AIA, retrying`);
	};
}

// basic-ftp hands the error (or the success) back before the write stream has
// flushed what the data socket delivered; on a timeout the file may not even
// be open yet. Measuring the file before the descriptor is closed resumes from
// the wrong byte and leaves two writers appending to the same file (on
// 2026-09-09 that broke a Keystone CSV and sent the seeds into OOM). Nothing
// reads or measures the file until the stream has closed.
function settleStream(stream) {
	return new Promise((resolve) => {
		if (!stream || stream.closed) return resolve();
		stream.once('close', resolve);
		stream.once('error', () => {});
		if (!stream.destroyed && !stream.writableEnded) stream.end();
	});
}

// The vendor's own byte count is the cheapest proof that the resumes added up
// to the whole file. A server without SIZE (or refusing it in this mode) is
// not an error; a mismatch throws the download away so the next attempt
// starts from zero instead of resuming on top of a broken file.
async function verifyRemoteSize(client, remoteFile, localPath, log) {
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
}

// When the vendor last wrote the file, the only way to tell today's export
// from yesterday's. Not every server answers MDTM, so a failure is not one.
async function readModifiedAt(client, remoteFile, log) {
	try {
		return await client.lastMod(remoteFile);
	} catch (error) {
		log.warn(`⚠️ Could not read the date of ${remoteFile} at the vendor: ${error.message}`);
		return null;
	}
}

const fileSize = (localPath) => (fs.existsSync(localPath) ? fs.statSync(localPath).size : 0);

async function connect(client, { ftp, caBundle, access }) {
	const { rejectUnauthorized, ...login } = access;
	client.ftp.socketTimeout = SOCKET_TIMEOUT_MS;
	client.prepareTransfer = ftp.enterPassiveModeIPv4;
	await client.access({
		...login,
		secureOptions: { rejectUnauthorized, ca: await caBundle.get(), servername: login.host },
		timeout: SOCKET_TIMEOUT_MS,
	});
}

// One connection, one transfer resumed from the bytes already on disk.
// Returns { ok: true, modifiedAt } or { ok: false, error, startAt }.
async function attemptDownload(transfer, remoteFile, localPath, attempt) {
	const { ftp, log } = transfer;
	const client = new ftp.Client();
	const startAt = fileSize(localPath);
	if (startAt > 0) log.log(`⏩ Resuming ${remoteFile} from byte ${startAt}`);
	let writeStream = null;
	try {
		await connect(client, transfer);
		const modifiedAt = await readModifiedAt(client, remoteFile, log);
		writeStream = fs.createWriteStream(localPath, { flags: startAt > 0 ? 'a' : 'w' });
		log.log(`📥 Downloading ${remoteFile} (attempt ${attempt})${modifiedAt ? `, published ${modifiedAt.toISOString()}` : ''}...`);
		await client.download(writeStream, remoteFile, startAt);
		await settleStream(writeStream);
		await verifyRemoteSize(client, remoteFile, localPath, log);
		client.close();
		return { ok: true, modifiedAt };
	} catch (error) {
		client.close();
		await settleStream(writeStream);
		return { ok: false, error, startAt };
	}
}

function createFtpsClient({
	secure,
	envPrefix,
	label,
	host,
	port,
	user = '',
	password = '',
	// Certificate VALIDATED by default. Without it, anyone on the network path
	// can terminate the session, capture the credentials and hand back a forged
	// feed. An explicit false is for diagnostics only.
	rejectUnauthorized = true,
	defaults = {},
	ftp = basicFtp,
	env = process.env,
	store = null,
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	fetchIntermediate = fetchIntermediateViaAia,
	// Injected so tests can keep the library quiet: raw console output from
	// the code under test interleaves with `node --test`'s serialized stdout
	// channel and the runner dies with "Unable to deserialize cloned data".
	log = console,
}) {
	assertOptions({ secure, envPrefix, label, host });
	const settings = resolveSettings({ env, envPrefix, label, defaults });
	const caBundle = createCaBundle({ env, envPrefix, label, caObjectKey: settings.caObjectKey, store, cacheDir, log });
	const recoverIntermediate = createIntermediateRecovery({
		secure, host, port, envPrefix, label, cacheDir, caBundle, fetchIntermediate, log,
	});

	const transfer = {
		ftp,
		log,
		caBundle,
		access: { host, port, user, password, secure, rejectUnauthorized },
	};

	const assertConfigured = () => {
		if (!user || !password) {
			throw new Error(`${envPrefix}_USER/${envPrefix}_PASS missing from the environment`);
		}
	};

	async function downloadFile(remoteFile, localPath) {
		assertConfigured();
		const { maxAttempts, retryDelayMs, downloadDeadlineMs } = settings;
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
			const outcome = await attemptDownload(transfer, remoteFile, localPath, attempt);
			if (outcome.ok) return { modifiedAt: outcome.modifiedAt };
			lastError = outcome.error;

			if (rejectUnauthorized && isMissingIntermediateError(outcome.error)) {
				await recoverIntermediate(outcome.error);
				continue;
			}

			// An attempt that advanced the file is the resume doing its job,
			// not a reason to give up: only consecutive stalls burn the budget.
			stalledAttempts = fileSize(localPath) > outcome.startAt ? 0 : stalledAttempts + 1;
			log.warn(
				`⚠️ Download of ${remoteFile} failed (attempt ${attempt}, ${stalledAttempts}/${maxAttempts} without progress): ${outcome.error.message}`
			);
			if (stalledAttempts < maxAttempts && retryDelayMs > 0) await sleep(retryDelayMs);
		}

		throw new Error(
			`Could not download ${remoteFile}: ${maxAttempts} consecutive attempts without progress, ${attempt} in total (last error: ${lastError?.message})`
		);
	}

	return { downloadFile };
}

module.exports = { createFtpsClient };
