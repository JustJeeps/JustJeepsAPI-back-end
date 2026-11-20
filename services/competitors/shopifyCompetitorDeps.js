// Production dependencies of a Shopify competitor run (DD-021, DD-022): real
// fetch, file system, prisma, IngestRun, run lock and log archive, wired for
// one store profile. Kept apart from the orchestration so the tests inject
// fakes; everything that opens the database is required lazily, so
// --collect-only never opens it.

const path = require('path');

const LOCK_MARGIN_MINUTES = 30;

function buildCompetitorDeps({ profile, argv, getConfig, getOfflineConfig, defaults, snapshotDir, vendorsPrefix }) {
	const fs = require('fs');
	const { createBrandReader } = require('../../lib/competitors/shopify/brands');
	const { createCollector } = require('../../lib/competitors/shopify/collect');
	const { createSnapshot } = require('../../lib/competitors/shopify/snapshot');
	const { buildReportCsv } = require('../../lib/competitors/shopify/report');
	const { readBrands, filterBrands } = createBrandReader(profile);
	const collectStore = createCollector(profile);
	const { snapshotFileName, validateSnapshot } = createSnapshot(profile);

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
		readFile: (file) => fs.readFileSync(file, 'utf8'),
		writeFile: (file, body) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		},
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

module.exports = { buildCompetitorDeps, LOCK_MARGIN_MINUTES };
