// Keystone FTPS client (ftp.ekeystone.com) for fetching the Inventory.csv /
// SpecialOrder.csv feeds: implicit FTPS on 990, credentials ALWAYS from env
// (KEYSTONE_FTP_USER/PASS already exist as a secret in the deploy; the legacy
// prisma/seeds/api-calls/keystone-ftp.js had them hardcoded).
//
// The download loop (byte resume, retry budget, deadline, SIZE check, CA
// bundle and AIA recovery) lives in lib/feeds/ftpsClient.js; this wrapper only
// supplies Keystone's constants and env names.
//
// The Keystone server sends ONLY the leaf certificate, without the
// intermediate. The CA comes from KEYSTONE_FTP_CA_PEM, KEYSTONE_FTP_CA_FILE or
// the private object in the Space (KEYSTONE_FTP_CA_OBJECT_KEY, default below),
// plus every intermediate fetched through AIA (Keystone changed CA on
// 2026-10-10 and the pinned intermediate silently stopped matching). See
// lib/feeds/ftpsCa.js.
//
// basic-ftp comes in as a parameter so the tests run without network.

const path = require('path');
const basicFtp = require('basic-ftp');
const { fetchIntermediateViaAia } = require('./aiaIntermediate');
const { createFtpsClient } = require('./ftpsClient');

const ENV_PREFIX = 'KEYSTONE_FTP';
const LABEL = 'Keystone';
const DEFAULT_HOST = 'ftp.ekeystone.com';
const DEFAULT_PORT = 990; // implicit FTPS
const DEFAULT_CA_OBJECT_KEY = 'certs/keystone-ftp-ca.pem';
// On 2026-08-28 a degraded evening burned 12 attempts at ~86% of the ~460MB
// file, so only consecutive attempts without progress count (see ftpsClient).
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_DOWNLOAD_DEADLINE_MS = 45 * 60 * 1000;

function createKeystoneFtpClient({
	ftp = basicFtp,
	env = process.env,
	store = null,
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	fetchIntermediate = fetchIntermediateViaAia,
	log = console,
} = {}) {
	return createFtpsClient({
		secure: 'implicit',
		envPrefix: ENV_PREFIX,
		label: LABEL,
		host: env.KEYSTONE_FTP_HOST || DEFAULT_HOST,
		port: Number(env.KEYSTONE_FTP_PORT || DEFAULT_PORT),
		user: env.KEYSTONE_FTP_USER || '',
		password: env.KEYSTONE_FTP_PASS || '',
		// Validated by default: the consumer runs with staleStrategy "delete",
		// so a forged feed would wipe real rows. The opt-out is for diagnostics.
		rejectUnauthorized: env.KEYSTONE_FTP_TLS_REJECT_UNAUTHORIZED !== 'false',
		defaults: {
			caObjectKey: DEFAULT_CA_OBJECT_KEY,
			maxAttempts: DEFAULT_MAX_ATTEMPTS,
			retryDelayMs: DEFAULT_RETRY_DELAY_MS,
			downloadDeadlineMs: DEFAULT_DOWNLOAD_DEADLINE_MS,
		},
		ftp,
		env,
		store,
		cacheDir,
		sleep,
		now,
		fetchIntermediate,
		log,
	});
}

module.exports = { createKeystoneFtpClient };
