// Niagara Jeeps competitor prices (DD-021). Thin runner: args, IngestRun
// bookkeeping, collect, snapshot, ingest, report, exit code. The logic lives
// in lib/competitors/niagara (pure) and services/competitors/niagaraIngest.js
// (prisma injected).
//
//   npm run seed-niagara                                  # collect + write
//   npm run seed-niagara -- --dry-run                     # collect + match report, no writes
//   npm run seed-niagara -- --collect-only                # collect + snapshot, never opens the database
//   npm run seed-niagara -- --brands=BIL,RC --max-pages=1 # sample run (skips the size floors)
//   npm run seed-niagara -- --from-snapshot <file>        # ingest a saved snapshot, no network
//
// Exit codes: 0 success, 1 failed (nothing written), 2 partial (written, the
// crawl stopped on its budget). Nothing is ever deleted: rows not seen are
// counted and reported.
//
// Dependencies are injected so the tests run without a database or network;
// the CLI wiring at the bottom only runs when this file is the entry point.

const path = require('path');

const FEED = 'niagara';
const COMMAND = 'seed-niagara';
const EXIT_PARTIAL = 2;
const PREVIEW_PER_BRAND = 10;
const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'niagara');

function parseArgs(argv) {
	const args = { dryRun: false, collectOnly: false, brands: [], maxPages: null, fromSnapshot: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--collect-only') args.collectOnly = true;
		else if (arg.startsWith('--brands=')) args.brands = arg.slice('--brands='.length).split(',').map((b) => b.trim()).filter(Boolean);
		else if (arg.startsWith('--max-pages=')) args.maxPages = Math.max(1, Number(arg.slice('--max-pages='.length)) || 1);
		else if (arg === '--from-snapshot') args.fromSnapshot = argv[++i] || null;
		else if (arg.startsWith('--from-snapshot=')) args.fromSnapshot = arg.slice('--from-snapshot='.length) || null;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (args.collectOnly && (args.dryRun || args.fromSnapshot)) throw new Error('--collect-only cannot be combined with --dry-run or --from-snapshot');
	return args;
}

const sampleOf = (args) => (args.brands.length || args.maxPages ? { brands: args.brands, maxPages: args.maxPages } : null);
const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');
const errorDetail = (error) => {
	const message = String(error && error.message ? error.message : error);
	return error && error.code && !message.startsWith(error.code) ? `${error.code}: ${message}` : message;
};

// The match-drop bar: rows written by the last successful FULL run. Dry,
// sample and partial runs wrote less on purpose, so they never set it.
async function lastFullRunRows(prisma) {
	const last = await prisma.ingestRun.findFirst({
		where: { feed: FEED, status: 'success', startedBy: { notIn: ['dry-run', 'sample'] } },
		orderBy: { startedAt: 'desc' },
		select: { sourceRowCount: true },
	});
	return last && Number(last.sourceRowCount) > 0 ? Number(last.sourceRowCount) : null;
}

function previewLines(items) {
	const byBrand = new Map();
	for (const item of items) {
		const list = byBrand.get(item.jjPrefix) || [];
		if (list.length < PREVIEW_PER_BRAND) byBrand.set(item.jjPrefix, [...list, item]);
	}
	return [...byBrand].flatMap(([prefix, list]) => list.map((i) => `  ${prefix} ${i.competitorSku} $${i.price}${i.available ? '' : ' (out of stock)'} ${i.url}`));
}

async function collectPayload({ deps, args, runId }) {
	if (args.fromSnapshot) return deps.validateSnapshot(JSON.parse(deps.readFile(args.fromSnapshot)));
	const brands = deps.filterBrands(deps.brands, args.brands);
	const { payload, invalidSample } = await deps.collect({ brands, runId, sample: sampleOf(args) });
	if (invalidSample.length) deps.logger.info(`[niagara] invalid sample: ${JSON.stringify(invalidSample.slice(0, 10))}`);
	return payload;
}

function saveFile(deps, name, body) {
	const filePath = path.join(deps.snapshotDir, name);
	deps.writeFile(filePath, body);
	return filePath;
}

async function runCollectOnly(deps, args) {
	const payload = await collectPayload({ deps, args, runId: null });
	const filePath = saveFile(deps, deps.snapshotFileName({ runId: null, stamp: stampOf(deps.now()) }), JSON.stringify(payload));
	deps.logger.info(`[niagara] collect-only: ${payload.items.length} items from ${payload.collection.brandsOk} brands, snapshot ${filePath}`);
	for (const line of previewLines(payload.items)) deps.logger.info(line);
	return { exitCode: 0, payload, snapshotPath: filePath };
}

async function archiveFiles(deps, files, startedAt, status) {
	for (const { filePath, extension, contentType } of files) {
		try {
			const result = await deps.archive({ filePath, command: COMMAND, startedAt, status, source: deps.env.INGEST_TRIGGER || 'cron', extension, contentType });
			deps.logger.info(`[niagara] archive: ${result.archived ? result.key : `skipped (${result.reason})`}`);
		} catch (error) {
			deps.logger.warn(`[niagara] archive of ${filePath} failed: ${error.message}`);
		}
	}
}

function startedByOf(args, sample, env) {
	if (args.dryRun) return 'dry-run';
	if (sample) return 'sample';
	return env.INGEST_TRIGGER || 'cron';
}

async function runIngest(deps, args) {
	const startedAt = deps.now();
	const stamp = stampOf(startedAt);
	const sample = sampleOf(args);
	const prisma = deps.getPrisma();
	const sourceRef = args.fromSnapshot || `${deps.baseUrl}${sample ? ' (sample)' : ''}${args.dryRun ? ' (dry-run)' : ''}`;
	const run = await deps.startRun(FEED, { sourceKind: args.fromSnapshot ? 'snapshot' : 'api', sourceRef, startedBy: startedByOf(args, sample, deps.env) });
	const finish = (outcome) => run.finish(outcome).catch((error) => deps.logger.warn(`[niagara] could not record the run outcome: ${error.message}`));
	deps.logger.info(`[niagara] run ${run.id} started${args.dryRun ? ' (dry-run)' : ''}${sample ? ` (sample ${JSON.stringify(sample)})` : ''} source=${sourceRef}`);

	try {
		const payload = await collectPayload({ deps, args, runId: run.id });
		const snapshotPath = args.fromSnapshot ? null
			: saveFile(deps, deps.snapshotFileName({ runId: run.id, dryRun: args.dryRun, sample: Boolean(sample), stamp }), JSON.stringify(payload));
		const result = await deps.ingest({ prisma, payload, baselineRows: await lastFullRunRows(prisma), dryRun: args.dryRun });
		const reportPath = saveFile(deps, `niagara-run-${run.id}-report-${stamp}.csv`, deps.buildReportCsv(result.report));

		const partial = Boolean(payload.collection && payload.collection.partial);
		const status = args.dryRun ? 'dry-run' : partial ? 'partial' : 'success';
		const counts = { ...result.counts, markedStale: result.counts.markedStale || 0 };
		await finish({ status, counts, sourceRowCount: result.matched, ...(partial ? { error: 'NIAGARA_PARTIAL: the crawl stopped on its budget' } : {}) });
		if (status === 'success' && !sample && snapshotPath) saveFile(deps, 'latest-snapshot.json', JSON.stringify(payload));
		if (!args.dryRun) {
			const files = [...(snapshotPath ? [{ filePath: snapshotPath, extension: 'json', contentType: 'application/json' }] : []), { filePath: reportPath, extension: 'csv', contentType: 'text/csv' }];
			await archiveFiles(deps, files, startedAt, status);
		}
		const summary = { runId: run.id, status, items: payload.items.length, matched: result.matched, matchRate: Number(result.matchRate.toFixed(3)), ...counts, collection: payload.collection, report: reportPath };
		deps.logger.info(`[niagara] SUMMARY ${JSON.stringify(summary)}`);
		if (partial) deps.logger.warn(`[niagara] run ${run.id} is PARTIAL: rows written, exit code ${EXIT_PARTIAL}`);
		return { exitCode: partial && !args.dryRun ? EXIT_PARTIAL : 0, summary };
	} catch (error) {
		const detail = errorDetail(error);
		deps.logger.error(`[niagara] run ${run.id} FAILED: ${detail}`);
		await finish({ status: 'failed', error: detail });
		return { exitCode: 1, error: detail };
	}
}

async function runSeedNiagara(deps) {
	let args;
	try {
		args = parseArgs(deps.argv);
	} catch (error) {
		deps.logger.error(`[niagara] ${error.message}`);
		return { exitCode: 1, error: error.message };
	}
	if (!args.collectOnly) return runIngest(deps, args);
	try {
		return await runCollectOnly(deps, args);
	} catch (error) {
		deps.logger.error(`[niagara] collect-only FAILED: ${errorDetail(error)}`);
		return { exitCode: 1, error: errorDetail(error) };
	}
}

function buildDeps(argv) {
	const fs = require('fs');
	const { getNiagaraConfig, getNiagaraOfflineConfig, DEFAULTS } = require('../../../config/niagara');
	const vendorsPrefix = require('../hard-code_data/vendors_prefix');
	const { niagaraBrands, filterBrands } = require('../../../lib/competitors/niagara/brands');
	const { collectNiagara } = require('../../../lib/competitors/niagara/collect');
	const { snapshotFileName, validateSnapshot } = require('../../../lib/competitors/niagara/snapshot');
	const { buildReportCsv } = require('../../../lib/competitors/niagara/report');

	const stamp = () => new Date().toISOString();
	const logger = {
		info: (m) => console.log(`[${stamp()}] ${m}`),
		warn: (m) => console.warn(`[${stamp()}] ${m}`),
		error: (m) => console.error(`[${stamp()}] ${m}`),
	};
	const offline = argv.some((a) => a.startsWith('--from-snapshot'));
	const config = offline ? getNiagaraOfflineConfig(process.env) : getNiagaraConfig(process.env);
	const brands = niagaraBrands(vendorsPrefix);
	let prisma = null;

	return {
		argv, env: process.env, logger, now: () => new Date(), baseUrl: config.baseUrl || DEFAULTS.baseUrl,
		brands, filterBrands, snapshotFileName, validateSnapshot, buildReportCsv, snapshotDir: SNAPSHOT_DIR,
		readFile: (file) => fs.readFileSync(file, 'utf8'),
		writeFile: (file, body) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		},
		collect: ({ brands: selected, runId, sample }) => collectNiagara({
			fetch, config, brands: selected, runId, logger, sample, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		}),
		// Required lazily: --collect-only must never open the database.
		getPrisma: () => {
			if (!prisma) prisma = require('../../../lib/prisma');
			return prisma;
		},
		startRun: (...a) => require('../../../lib/ingest/ingestRun').startRun(...a),
		ingest: (input) => require('../../../services/competitors/niagaraIngest').ingestNiagara({ ...input, brands, thresholds: config.thresholds, logger }),
		archive: (input) => require('../../../services/logArchive/logArchiveService').createLogArchive({ logger }).archiveFile(input),
		disconnect: async () => {
			if (prisma) await prisma.$disconnect();
		},
	};
}

async function main() {
	let deps = null;
	try {
		deps = buildDeps(process.argv.slice(2));
		const result = await runSeedNiagara(deps);
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(`[niagara] fatal: ${errorDetail(error)}`);
		process.exitCode = 1;
	} finally {
		if (deps) await deps.disconnect();
	}
}

if (require.main === module) main();
module.exports = { runSeedNiagara, parseArgs, lastFullRunRows, EXIT_PARTIAL };
