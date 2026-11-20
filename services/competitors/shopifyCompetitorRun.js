// Shared run orchestration for a Shopify competitor scraper (DD-021, DD-022):
// args, IngestRun bookkeeping, run lock, collect, snapshot, ingest, report,
// archive and exit code, written once and created per store profile (feed key,
// codes, log tag, command). The runner script of each store only builds its
// dependencies and calls runSeed.
//
// Exit codes: 0 success, 1 failed (nothing written, except <PREFIX>_WRITE_FAILED
// and <PREFIX>_RUN_NOT_RECORDED, which say what was), 2 partial (written, the
// crawl stopped on its budget). Nothing is ever deleted: rows not seen are
// counted and reported.

const path = require('path');

const EXIT_PARTIAL = 2;
const PREVIEW_PER_BRAND = 10;

// A bad value must fail loudly: an empty --brands or a missing snapshot path
// would otherwise turn a sample or a replay into a full live run that writes.
function parseBrands(value) {
	const brands = value.split(',').map((b) => b.trim()).filter(Boolean);
	if (!brands.length) throw new Error('--brands needs at least one prefix, e.g. --brands=BIL,RC');
	return brands;
}

function parseMaxPages(value) {
	const pages = Number(value);
	if (!/^\d+$/.test(value) || pages < 1) throw new Error(`--max-pages must be a whole number of 1 or more, got "${value}"`);
	return pages;
}

function snapshotPathOf(value) {
	if (!value || value.startsWith('--')) throw new Error('--from-snapshot needs a file path');
	return value;
}

function parseArgs(argv) {
	const args = { dryRun: false, collectOnly: false, brands: [], maxPages: null, fromSnapshot: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--collect-only') args.collectOnly = true;
		else if (arg.startsWith('--brands=')) args.brands = parseBrands(arg.slice('--brands='.length));
		else if (arg.startsWith('--max-pages=')) args.maxPages = parseMaxPages(arg.slice('--max-pages='.length));
		else if (arg === '--from-snapshot') args.fromSnapshot = snapshotPathOf(argv[++i]);
		else if (arg.startsWith('--from-snapshot=')) args.fromSnapshot = snapshotPathOf(arg.slice('--from-snapshot='.length));
		else throw new Error(`unknown argument ${arg}`);
	}
	if (args.collectOnly && (args.dryRun || args.fromSnapshot)) throw new Error('--collect-only cannot be combined with --dry-run or --from-snapshot');
	return args;
}

const sampleOf = (args) => (args.brands.length || args.maxPages ? { brands: args.brands, maxPages: args.maxPages } : null);
// A gzipped snapshot is archived as such; a plain one as before.
const archiveTypeOf = (filePath) => (filePath.endsWith('.json.gz')
	? { filePath, extension: 'json.gz', contentType: 'application/gzip' }
	: { filePath, extension: 'json', contentType: 'application/json' });
const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');
const errorDetail = (error) => {
	const message = String(error && error.message ? error.message : error);
	return error && error.code && !message.startsWith(error.code) ? `${error.code}: ${message}` : message;
};

// The match-drop bar: rows written by the last successful FULL run. Dry,
// sample and partial runs wrote less on purpose, so they never set it.
async function lastFullRunRows(FEED, prisma) {
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

function readSnapshot(deps, file) {
	return deps.validateSnapshot(JSON.parse(deps.readFile(file)));
}

async function collectPayload({ deps, args, runId, tag }) {
	const brands = deps.filterBrands(deps.brands, args.brands);
	const { payload, invalidSample } = await deps.collect({ brands, runId, sample: sampleOf(args) });
	if (invalidSample.length) deps.logger.info(`${tag} invalid sample: ${JSON.stringify(invalidSample.slice(0, 10))}`);
	return payload;
}

function saveFile(deps, name, body) {
	const filePath = path.join(deps.snapshotDir, name);
	deps.writeFile(filePath, body);
	return filePath;
}

async function runCollectOnly(profile, deps, args) {
	const { tag } = profile;
	const payload = await collectPayload({ deps, args, runId: null, tag });
	const filePath = saveFile(deps, deps.snapshotFileName({ runId: null, stamp: stampOf(deps.now()) }), JSON.stringify(payload));
	deps.logger.info(`${tag} collect-only: ${payload.items.length} items from ${payload.collection.brandsOk} brands, snapshot ${filePath}`);
	for (const line of previewLines(payload.items)) deps.logger.info(line);
	return { exitCode: 0, payload, snapshotPath: filePath };
}

async function archiveFiles(profile, deps, files, startedAt, status) {
	const { tag, command: COMMAND } = profile;
	for (const { filePath, extension, contentType } of files) {
		try {
			const result = await deps.archive({ filePath, command: COMMAND, startedAt, status, source: deps.env.INGEST_TRIGGER || 'cron', extension, contentType });
			deps.logger.info(`${tag} archive: ${result.archived ? result.key : `skipped (${result.reason})`}`);
		} catch (error) {
			deps.logger.warn(`${tag} archive of ${filePath} failed: ${error.message}`);
		}
	}
}

function startedByOf(args, sample, env) {
	if (args.dryRun) return 'dry-run';
	if (sample) return 'sample';
	return env.INGEST_TRIGGER || 'cron';
}

// File writes after the database write are best effort: a full disk must not
// turn a run that wrote rows into a "failed" one.
function bestEffort(deps, label, fn, tag) {
	try {
		return fn();
	} catch (error) {
		deps.logger.warn(`${tag} could not save the ${label}: ${error.message}`);
		return null;
	}
}

async function runIngestUnlocked(profile, deps, args) {
	const { tag, code, key: FEED } = profile;
	const save = (label, fn) => bestEffort(deps, label, fn, tag);
	const startedAt = deps.now();
	const stamp = stampOf(startedAt);
	// A snapshot is read before the run starts, so a saved sample replayed with
	// --from-snapshot is still labelled sample and never becomes the baseline.
	let snapshot = null;
	try {
		snapshot = args.fromSnapshot ? readSnapshot(deps, args.fromSnapshot) : null;
	} catch (error) {
		deps.logger.error(`${tag} ${errorDetail(error)}`);
		return { exitCode: 1, error: errorDetail(error) };
	}
	const sample = sampleOf(args) || (snapshot && snapshot.sample) || null;
	const prisma = deps.getPrisma();
	const sourceRef = args.fromSnapshot || `${deps.baseUrl}${sample ? ' (sample)' : ''}${args.dryRun ? ' (dry-run)' : ''}`;
	const run = await deps.startRun(FEED, { sourceKind: args.fromSnapshot ? 'snapshot' : 'api', sourceRef, startedBy: startedByOf(args, sample, deps.env) });
	// Resolves to false when the outcome could not be recorded, so a run that
	// wrote rows does not exit 0 while its IngestRun stays "running".
	const finish = (outcome) => run.finish(outcome).then(() => true, (error) => {
		deps.logger.error(`${tag} could not record the run outcome: ${error.message}`);
		return false;
	});
	deps.logger.info(`${tag} run ${run.id} started${args.dryRun ? ' (dry-run)' : ''}${sample ? ` (sample ${JSON.stringify(sample)})` : ''} source=${sourceRef}`);

	let payload;
	let snapshotPath = null;
	let result;
	try {
		payload = snapshot || await collectPayload({ deps, args, runId: run.id, tag });
		if (!snapshot) {
			snapshotPath = save('snapshot', () => saveFile(deps, deps.snapshotFileName({ runId: run.id, dryRun: args.dryRun, sample: Boolean(sample), stamp }), JSON.stringify(payload)));
		}
		result = await deps.ingest({ prisma, payload, baselineRows: await lastFullRunRows(FEED, prisma), dryRun: args.dryRun });
	} catch (error) {
		const detail = errorDetail(error);
		deps.logger.error(`${tag} run ${run.id} FAILED: ${detail}`);
		await finish({ status: 'failed', error: detail, ...(error.counts ? { counts: error.counts } : {}) });
		if (error.report) {
			const reportPath = save('report', () => saveFile(deps, `${FEED}-run-${run.id}-report-${stamp}.csv`, deps.buildReportCsv(error.report)));
			if (reportPath) deps.logger.info(`${tag} match report of the refused run: ${reportPath}`);
		}
		return { exitCode: 1, error: detail };
	}

	const partial = Boolean(payload.collection && payload.collection.partial);
	const status = args.dryRun ? 'dry-run' : partial ? 'partial' : 'success';
	const counts = { ...result.counts, markedStale: result.counts.markedStale || 0 };
	const recorded = await finish({ status, counts, sourceRowCount: result.matched, ...(partial ? { error: `${code('PARTIAL')}: the crawl stopped on its budget` } : {}) });

	const reportPath = save('report', () => saveFile(deps, `${FEED}-run-${run.id}-report-${stamp}.csv`, deps.buildReportCsv(result.report)));
	if (status === 'success' && !sample && snapshotPath) save('latest snapshot', () => saveFile(deps, deps.latestSnapshotName || 'latest-snapshot.json', JSON.stringify(payload)));
	if (!args.dryRun) {
		const files = [
			...(snapshotPath ? [archiveTypeOf(snapshotPath)] : []),
			...(reportPath ? [{ filePath: reportPath, extension: 'csv', contentType: 'text/csv' }] : []),
		];
		await archiveFiles(profile, deps, files, startedAt, status);
	}
	const summary = { runId: run.id, status, items: payload.items.length, matched: result.matched, matchRate: Number(result.matchRate.toFixed(3)), ...counts, collection: payload.collection, report: reportPath };
	deps.logger.info(`${tag} SUMMARY ${JSON.stringify(summary)}`);
	if (partial) deps.logger.warn(`${tag} run ${run.id} is PARTIAL: rows written, exit code ${EXIT_PARTIAL}`);
	if (!recorded) {
		const error = `${code('RUN_NOT_RECORDED')}: run ${run.id} finished (${status}) but its outcome was not saved`;
		deps.logger.error(`${tag} ${error}`);
		return { exitCode: 1, error, summary };
	}
	return { exitCode: partial && !args.dryRun ? EXIT_PARTIAL : 0, summary };
}

// One run at a time across processes: the cron and a manual `kamal app exec`
// would otherwise both insert the same new SKUs (no unique key on
// CompetitorProduct) and could create the competitor twice. The lease outlives
// the run budget, and a live lease also keeps the boot-time stale-run cleanup
// from marking this run as interrupted.
async function runIngest(profile, deps, args) {
	const { tag, code, key: FEED, shortName } = profile;
	if (!(await deps.lock.acquire(FEED, { leaseMinutes: deps.leaseMinutes }))) {
		const error = `${code('BUSY')}: another ${shortName} run holds the lock; nothing was done`;
		deps.logger.error(`${tag} ${error}`);
		return { exitCode: 1, error };
	}
	try {
		return await runIngestUnlocked(profile, deps, args);
	} finally {
		await deps.lock.release(FEED).catch((error) => deps.logger.warn(`${tag} could not release the lock: ${error.message}`));
	}
}

async function runSeed(profile, deps) {
	const { tag } = profile;
	let args;
	try {
		args = parseArgs(deps.argv);
	} catch (error) {
		deps.logger.error(`${tag} ${error.message}`);
		return { exitCode: 1, error: error.message };
	}
	if (!args.collectOnly) return runIngest(profile, deps, args);
	try {
		return await runCollectOnly(profile, deps, args);
	} catch (error) {
		deps.logger.error(`${tag} collect-only FAILED: ${errorDetail(error)}`);
		return { exitCode: 1, error: errorDetail(error) };
	}
}

function createCompetitorRun(profile) {
	return {
		runSeed: (deps) => runSeed(profile, deps),
		lastFullRunRows: (prisma) => lastFullRunRows(profile.key, prisma),
		parseArgs,
		EXIT_PARTIAL,
	};
}

module.exports = { createCompetitorRun, parseArgs, EXIT_PARTIAL, errorDetail };
