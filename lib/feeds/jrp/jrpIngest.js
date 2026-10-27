// JRP apply: catalogued JUSJEE.csv -> VendorProduct. Order: hash gate, parse,
// shrink gate, invalid ratio gate, match, min matched gate; only then the
// vendor lookup/creation, the staged diff (staleStrategy 'none') and the
// report upload. Every dependency is injected (the script wires the real
// ones), so tests run the whole flow without a database or Spaces.
//
// Dry run: same gates and matching, reads only. No lock, no staging, no
// VendorProduct write, no vendor creation, no report upload and no IngestRun
// (the run helpers have no dry-run flag).

const jrp = require('../../../config/jrp');
const { readFeed: defaultReadFeed } = require('./readFeed');
const { matchRows } = require('./matchRows');
const gates = require('./jrpGates');
const report = require('./unmatchedReport');
const write = require('./jrpWrite');

const SOURCE_KIND = 'ftp-csv';
const TAG = '[jrp]';

class GateError extends Error {}

function failIf(reason) {
	if (reason) throw new GateError(reason);
}

const tally = (entries) => entries.reduce((acc, { reason }) => ({ ...acc, [reason]: (acc[reason] || 0) + 1 }), {});
const formatTally = (counts) => Object.entries(counts).map(([reason, n]) => `${reason}=${n}`).join(' ');

async function resolveSource({ prisma, materialize, getCurrentBatch, hashFile }) {
	const materialized = await materialize(jrp.FEED_ID);
	const filePath = materialized.files[jrp.REMOTE_FILE];
	const batch = await getCurrentBatch(prisma, jrp.FEED_ID, [jrp.REMOTE_FILE]);
	const artifact = batch && batch.batchId === materialized.batchId
		? batch.artifacts.find((entry) => entry.fileName === jrp.REMOTE_FILE)
		: null;
	// The materializer verifies the download against the artifact sha256; when
	// it fell back to an older cached batch, hash what is actually on disk.
	const sha256 = artifact && artifact.sha256 ? artifact.sha256 : await hashFile(filePath);
	return { filePath, batchId: materialized.batchId, sha256 };
}

async function lastSuccessfulRowCount(prisma) {
	const last = await prisma.ingestRun.findFirst({
		where: { feed: jrp.FEED_ID, status: 'success', sourceRowCount: { not: null } },
		orderBy: { id: 'desc' },
		select: { sourceRowCount: true },
	});
	return last ? last.sourceRowCount : null;
}

function logMatch(log, match) {
	log.info(`${TAG} match matched=${match.matched.length} ambiguous=${match.ambiguousCount} unmatched=${match.unmatched.length} skipped-inactive=${match.inactive.length}`);
	const sample = report.formatSample(match.unmatched);
	if (sample.length === 0) return;
	log.info(`${TAG} unmatched sample (${sample.length} of ${match.unmatched.length}): brand | JRPSKU | OEMSKU | reason`);
	sample.forEach((line) => log.info(`${TAG}   ${line}`));
}

async function evaluate(deps, source) {
	const { prisma, env, log } = deps;
	const readFeed = deps.readFeed || defaultReadFeed;
	const feed = await readFeed(source.filePath, { stockPlusValue: jrp.STOCK_PLUS_VALUE });
	const invalidByReason = tally(feed.invalid);
	log.info(`${TAG} parsed rows=${feed.rowsRead} valid=${feed.rows.length} invalid=${feed.invalid.length} ${formatTally(invalidByReason)}`.trim());

	const lastRowCount = await lastSuccessfulRowCount(prisma);
	failIf(gates.shrinkGate({ rowsRead: feed.rowsRead, lastRowCount, minRatio: jrp.MIN_SIZE_RATIO }));
	failIf(gates.invalidRatioGate({ rowsRead: feed.rowsRead, invalidCount: feed.invalid.length, maxRatio: jrp.MAX_INVALID_RATIO }));

	const match = await matchRows(feed.rows, {
		labelToPrefix: jrp.brandLabelToPrefix(deps.vendorsPrefix),
		activePrefixes: jrp.activeBrands(env),
		oemStrip: jrp.OEM_STRIP,
		loadProductsForPrefix: deps.loadProductsForPrefix || write.createProductLoader(prisma),
	});
	logMatch(log, match);
	const minMatched = jrp.minMatched(env);
	failIf(gates.minMatchedGate({ matched: match.matched.length, minMatched }));
	log.info(`${TAG} gates ok: rows=${feed.rowsRead} (last ${lastRowCount ?? 'none'}), invalid=${feed.invalid.length}, matched=${match.matched.length} (min ${minMatched})`);

	return {
		...match,
		rowsRead: feed.rowsRead,
		invalidCount: feed.invalid.length,
		invalidByReason,
		mapBelowCost: feed.rows.filter((row) => row.mapBelowCost).length,
	};
}

function summarize(plan, applied, stale) {
	return {
		rowsParsed: plan.rowsRead,
		matched: plan.matched.length,
		ambiguous: plan.ambiguousCount,
		unmatched: plan.unmatched.length,
		invalid: plan.invalidCount,
		invalidByReason: plan.invalidByReason,
		inactive: plan.inactive.length,
		mapBelowCost: plan.mapBelowCost,
		inserted: applied ? applied.inserted : null,
		updated: applied ? applied.updated : null,
		stale: stale.length,
	};
}

// IngestRun has fixed columns: the rest of the breakdown goes to the log.
const runCounts = (counts) => ({
	inserted: counts.inserted,
	updated: counts.updated,
	markedStale: counts.stale,
	skipped: counts.invalid + counts.unmatched + counts.inactive,
});

function logDone(log, status, counts, failures) {
	log.info(`${TAG} done status=${status} parsed=${counts.rowsParsed} matched=${counts.matched} ambiguous=${counts.ambiguous} unmatched=${counts.unmatched} invalid=${counts.invalid} skipped-inactive=${counts.inactive} map-below-cost=${counts.mapBelowCost} inserted=${counts.inserted ?? 'n/a'} updated=${counts.updated ?? 'n/a'} stale=${counts.stale} failures=${failures}`);
}

function putText(store, key, text, contentType) {
	const body = Buffer.from(text, 'utf8');
	return store.putStream({ key, body, contentLength: body.length, contentType });
}

async function uploadReport({ store, now, log }, runId, plan, stale, counts) {
	const keys = report.reportKeys({ keyPrefix: store.keyPrefix(), runId });
	const lists = { unmatched: plan.unmatched, inactive: plan.inactive, stale };
	try {
		await putText(store, keys.json, report.buildReportJson({ runId, generatedAt: now(), counts, ...lists }), 'application/json');
		await putText(store, keys.csv, report.buildReportCsv(lists), 'text/csv');
	} catch (error) {
		throw new Error(`Report upload failed after the apply (VendorProduct was written, a rerun is safe): ${error.message}`);
	}
	log.info(`${TAG} report json=${keys.json} csv=${keys.csv}`);
	return keys;
}

async function failRun({ log }, run, error) {
	const message = error instanceof Error ? error.message : String(error);
	log.error(`${TAG} FAILED${error instanceof GateError ? ' (gate)' : ''}: ${message}`);
	if (run) {
		await run.finish({ status: 'failed', error: message })
			.catch((finishError) => log.error(`${TAG} could not record the failed run: ${finishError.message}`));
	}
	return { status: 'failed', error: message };
}

async function applyRun(deps, source, { force }) {
	const { prisma, ingestRun, log } = deps;
	const run = await ingestRun.startRun(jrp.FEED_ID, {
		sourceKind: SOURCE_KIND, sourceRef: jrp.REMOTE_FILE, sourceHash: source.sha256, artifactBatchId: source.batchId,
	});
	try {
		if (!force && await ingestRun.isUnchanged(jrp.FEED_ID, source.sha256)) {
			log.info(`${TAG} source identical to the last successful run (sha ${source.sha256.slice(0, 8)}): nothing to do`);
			await run.finish({ status: 'skipped-unchanged', counts: { skipped: 1 } });
			return { status: 'skipped-unchanged' };
		}
		const plan = await evaluate(deps, source);
		const { vendor, created } = await write.findOrCreateVendor(prisma);
		log.info(`${TAG} vendor ${jrp.VENDOR_NAME} id=${vendor.id}${created ? ' (created)' : ''}`);
		const stale = await write.listStale(prisma, vendor.id, plan.matched);
		const applied = await write.writeMatched(deps, vendor.id, plan.matched);
		const counts = summarize(plan, applied, stale);
		log.info(`${TAG} applied staged=${applied.staged} inserted=${applied.inserted} updated=${applied.updated} unchanged=${applied.staged - applied.inserted - applied.updated} stale=${stale.length} (listed only, nothing deleted)`);
		const reportKeys = await uploadReport(deps, run.id, plan, stale, counts);
		await run.finish({ status: 'success', counts: runCounts(counts), sourceRowCount: plan.rowsRead });
		logDone(log, 'success', counts, 0);
		return { status: 'success', runId: run.id, counts, reportKeys };
	} catch (error) {
		return failRun(deps, run, error);
	}
}

async function dryRun(deps, source, { force }) {
	const { prisma, ingestRun, log } = deps;
	log.info(`${TAG} DRY RUN: reads only, nothing is written, uploaded or recorded`);
	try {
		if (!force && await ingestRun.isUnchanged(jrp.FEED_ID, source.sha256)) {
			log.info(`${TAG} DRY RUN: source identical to the last successful run, a real run would skip (add --force to evaluate it)`);
			return { status: 'skipped-unchanged', dryRun: true };
		}
		const plan = await evaluate(deps, source);
		const vendor = await write.findVendor(prisma);
		const stale = await write.listStale(prisma, vendor ? vendor.id : null, plan.matched);
		const counts = summarize(plan, null, stale);
		log.info(`${TAG} DRY RUN: would stage ${counts.matched} rows for vendor ${vendor ? `id=${vendor.id}` : `${jrp.VENDOR_NAME} (to be created)`}`);
		logDone(log, 'dry-run', counts, 0);
		return { status: 'dry-run', dryRun: true, counts };
	} catch (error) {
		return failRun(deps, null, error);
	}
}

async function recordSourceFailure(deps, error) {
	const run = await deps.ingestRun.startRun(jrp.FEED_ID, { sourceKind: SOURCE_KIND, sourceRef: jrp.REMOTE_FILE });
	return failRun(deps, run, error);
}

async function applyLocked(deps, options) {
	const { lock, log } = deps;
	if (!(await lock.acquire(jrp.FEED_ID))) {
		log.warn(`${TAG} another ${jrp.FEED_ID} run holds the lock: skipped`);
		return { status: 'skipped-locked' };
	}
	try {
		let source;
		try {
			source = await resolveSource(deps);
		} catch (error) {
			return await recordSourceFailure(deps, error);
		}
		log.info(`${TAG} source batch=${source.batchId} sha=${source.sha256.slice(0, 8)} file=${source.filePath}`);
		return await applyRun(deps, source, options);
	} finally {
		await lock.release(jrp.FEED_ID);
		await deps.stage.close();
	}
}

async function runJrpIngest(deps, { dryRun: isDryRun = false, force = false } = {}) {
	if (!isDryRun) return applyLocked(deps, { force });
	let source;
	try {
		source = await resolveSource(deps);
	} catch (error) {
		return failRun(deps, null, error);
	}
	return dryRun(deps, source, { force });
}

module.exports = { runJrpIngest, GateError };
