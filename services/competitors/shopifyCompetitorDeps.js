// Production dependencies of a Shopify competitor run (DD-021, DD-022): real
// fetch, file system, prisma, IngestRun, run lock and log archive, wired for
// one store profile. Kept apart from the orchestration so the tests inject
// fakes; everything that opens the database is required lazily, so
// --collect-only never opens it.

const path = require('path');

const LOCK_MARGIN_MINUTES = 30;

// Snapshot and report files. A name ending in .gz is gzipped on write and
// gunzipped on read (DD-022); every other file is plain UTF-8 as before.
function snapshotFiles() {
	const fs = require('fs');
	const zlib = require('zlib');
	const isGzip = (file) => file.endsWith('.gz');
	return {
		readFile: (file) => (isGzip(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8')),
		writeFile: (file, body) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, isGzip(file) ? zlib.gzipSync(body) : body);
		},
	};
}

function buildCompetitorDeps({ profile, argv, getConfig, getOfflineConfig, defaults, snapshotDir, vendorsPrefix }) {
	const { createBrandReader } = require('../../lib/competitors/shopify/brands');
	const { createCollector } = require('../../lib/competitors/shopify/collect');
	const { createSnapshot } = require('../../lib/competitors/shopify/snapshot');
	const { buildReportCsv } = require('../../lib/competitors/shopify/report');
	const { readBrands, filterBrands } = createBrandReader(profile);
	const collectStore = createCollector(profile);
	const { snapshotFileName, validateSnapshot, latestSnapshotName } = createSnapshot(profile);
	const { readFile, writeFile } = snapshotFiles();

	const stamp = () => new Date().toISOString();
	const logger = {
		info: (m) => console.log(`[${stamp()}] ${m}`),
		warn: (m) => console.warn(`[${stamp()}] ${m}`),
		error: (m) => console.error(`[${stamp()}] ${m}`),
	};
	const offline = argv.some((a) => a.startsWith('--from-snapshot'));
	const config = offline ? getOfflineConfig(process.env) : getConfig(process.env);
	const brands = readBrands(vendorsPrefix);
	let prisma = null;

	return {
		argv, env: process.env, logger, now: () => new Date(), baseUrl: config.baseUrl || defaults.baseUrl,
		brands, filterBrands, snapshotFileName, buildReportCsv, snapshotDir,
		validateSnapshot: (payload) => validateSnapshot(payload, {
			now: () => new Date(), maxAgeHours: config.snapshotMaxAgeHours, maxPrice: config.maxPrice, thresholds: config.thresholds,
		}),
		readFile,
		writeFile,
		latestSnapshotName,
		collect: ({ brands: selected, runId, sample }) => collectStore({
			fetch, config, brands: selected, runId, logger, sample, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		}),
		// Required lazily: --collect-only must never open the database.
		getPrisma: () => {
			if (!prisma) prisma = require('../../lib/prisma');
			return prisma;
		},
		startRun: (...a) => require('../../lib/ingest/ingestRun').startRun(...a),
		ingest: (input) => require('./shopifyIngest').createShopifyIngest(profile)({ ...input, brands, thresholds: config.thresholds, logger }),
		archive: (input) => require('../logArchive/logArchiveService').createLogArchive({ logger }).archiveFile(input),
		leaseMinutes: (config.maxRunMinutes || defaults.maxRunMinutes) + LOCK_MARGIN_MINUTES,
		lock: {
			acquire: (...a) => require('../../lib/ingest/runLock').acquireIngestLock(...a),
			release: (...a) => require('../../lib/ingest/runLock').releaseIngestLock(...a),
		},
		disconnect: async () => {
			if (prisma) await prisma.$disconnect();
		},
	};
}

module.exports = { buildCompetitorDeps, snapshotFiles, LOCK_MARGIN_MINUTES };
