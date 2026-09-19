// Lowriders competitor prices for Rough Country (DD-018). Thin runner: env ->
// config, IngestRun bookkeeping, collect, snapshot, ingest, exit code. All the
// logic lives in lib/competitors/lowriders (pure) and
// services/competitors/lowridersIngest (prisma injected).
//
//   npm run seed-lowriders              # collect + write
//   npm run seed-lowriders -- --dry-run # collect + match report, no writes

const fs = require('fs');
const path = require('path');

const prisma = require('../../../lib/prisma');
const { startRun } = require('../../../lib/ingest/ingestRun');
const { withRetry } = require('../../../lib/ingest/withRetry');
const { collectLowriders, LowridersCollectError } = require('../../../lib/competitors/lowriders/collect');
const { ingestLowriders } = require('../../../services/competitors/lowridersIngest');
const { createLogArchive } = require('../../../services/logArchive/logArchiveService');
const { getLowridersConfig } = require('../../../config/lowriders');

const FEED = 'lowriders';
const COMMAND = 'seed-lowriders';
const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'lowriders');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'latest-snapshot.json');

const stamp = () => new Date().toISOString();
const logger = {
	info: (m) => console.log(`[${stamp()}] ${m}`),
	warn: (m) => console.warn(`[${stamp()}] ${m}`),
	error: (m) => console.error(`[${stamp()}] ${m}`),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeSnapshot(payload) {
	fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
	fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
	return SNAPSHOT_FILE;
}

async function archiveSnapshot(filePath, startedAt, status) {
	try {
		const archive = createLogArchive({ logger });
		const result = await archive.archiveFile({ filePath, command: COMMAND, startedAt, status, source: process.env.INGEST_TRIGGER || 'cron', extension: 'json' });
		logger.info(`[lowriders] snapshot archive: ${result.archived ? result.key : `skipped (${result.reason})`}`);
	} catch (err) {
		logger.warn(`[lowriders] snapshot archive failed: ${err.message}`);
	}
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const config = getLowridersConfig(process.env);
	const startedAt = new Date();
	const run = await startRun(FEED, {
		sourceKind: 'api',
		sourceRef: dryRun ? `${config.brandPageUrl} (dry-run)` : config.brandPageUrl,
		startedBy: dryRun ? 'dry-run' : process.env.INGEST_TRIGGER || 'cron',
	});
	logger.info(`[lowriders] run ${run.id} started${dryRun ? ' (dry-run)' : ''} brand=${config.brandId} pageSize=${config.pageSize}`);

	let status = 'failed';
	try {
		const { payload, invalidSample } = await collectLowriders({ fetch, config, runId: run.id, logger, sleep, withRetry });
		if (invalidSample.length) logger.info(`[lowriders] invalid sample: ${JSON.stringify(invalidSample.slice(0, 10))}`);

		const snapshotPath = writeSnapshot(payload);
		const result = await ingestLowriders({ prisma, payload, thresholds: config.thresholds, logger, dryRun });

		status = 'success';
		await run.finish({ status, counts: result.counts, sourceRowCount: payload.items.length }).catch((err) => {
			logger.warn(`[lowriders] could not record the run outcome: ${err.message}`);
		});
		await archiveSnapshot(snapshotPath, startedAt, status);
		logger.info(`[lowriders] run ${run.id} finished: matched=${result.matched} matchRate=${result.matchRate.toFixed(3)} inserted=${result.counts.inserted} updated=${result.counts.updated} unchanged=${result.counts.unchanged} deleted=${result.counts.deleted} skipped=${result.counts.skipped}${dryRun ? ' (dry-run, nothing written)' : ''}`);
		process.exitCode = 0;
	} catch (err) {
		const detail = err instanceof LowridersCollectError ? err.failures.map((f) => f.code).join(',') : `${err.code ? err.code + ': ' : ''}${err.message}`;
		logger.error(`[lowriders] run ${run.id} FAILED: ${err.message}`);
		await run.finish({ status: 'failed', error: detail }).catch(() => {});
		process.exitCode = 1;
	}
}

main()
	.catch((err) => {
		console.error(`[${stamp()}] [lowriders] fatal: ${err.message}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
