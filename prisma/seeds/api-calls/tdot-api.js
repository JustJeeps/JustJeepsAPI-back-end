// TDOT competitor prices: acquisition facade (DD-019). Replaces the ParseHub
// download with the in-house Klevu collector (lib/competitors/tdot) and keeps
// the contract seed-tdot.js consumes:
//   tdotCost() -> [{ tdot_price, tdot_code, sku, brand, product_url }]
//
// Escape hatch during the cutover: TDOT_SOURCE=parsehub reads ParseHub's last
// ready run with PARSEHUB_API_KEY from the environment (never a literal).

const fs = require('fs');
const path = require('path');

const { getTdotConfig, getTdotOfflineConfig } = require('../../../config/tdot');
const { collectTdot, TdotCollectError, SOURCE } = require('../../../lib/competitors/tdot/collect');
const { checkTdotRun } = require('../../../lib/competitors/tdot/canaries');
const { toLegacyRows } = require('../../../lib/competitors/tdot/legacyAdapter');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'tdot');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'latest-snapshot.json');
const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_PARSEHUB_PROJECT = 't84q4nt7WzTR';
const KLEVU_SOURCE_REF = 'klevu:tdotperformance.ca';

const TARGET_WHERE = { AND: [{ tdot_code: { not: null } }, { tdot_code: { not: '' } }] };
const TARGET_SELECT = { sku: true, searchable_sku: true, tdot_code: true, status: true };

// The labels we know TDOT by: every tdot_code in vendors_prefix.js.
function loadLabels() {
	const vendors = require('../hard-code_data/vendors_prefix.js');
	return [...new Set((vendors || []).map((v) => String(v.tdot_code || '').trim()).filter(Boolean))];
}

// One file per run so a dry run never overwrites the last real snapshot;
// latest-snapshot.json is refreshed by real runs only (the path the runbook
// names for --from-snapshot).
function snapshotFileName({ runId, dryRun, capturedAt }) {
	const stamp = String(capturedAt).replace(/\.\d+Z$/, '').replace(/:/g, '-');
	return `tdot-run-${runId == null ? 'manual' : runId}${dryRun ? '-dry-run' : ''}-${stamp}.json`;
}

function defaultWriteSnapshot(payload, { dryRun = false, runId = null } = {}) {
	fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
	const filePath = path.join(SNAPSHOT_DIR, snapshotFileName({ runId, dryRun, capturedAt: payload.capturedAt || new Date().toISOString() }));
	const body = JSON.stringify(payload);
	fs.writeFileSync(filePath, body);
	if (!dryRun) fs.writeFileSync(SNAPSHOT_FILE, body);
	return filePath;
}

function defaultReadSnapshot(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// A snapshot is trusted only when it is ours and passes the same canaries the
// live collector applies; otherwise --from-snapshot would be a way around them.
function validateSnapshot(payload, thresholds) {
	const invalid = (what) => Object.assign(new Error(`TDOT_SNAPSHOT_INVALID: ${what}`), { code: 'TDOT_SNAPSHOT_INVALID' });
	if (!payload || typeof payload !== 'object') throw invalid('not a JSON object');
	if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw invalid(`schemaVersion ${payload.schemaVersion}, expected ${SNAPSHOT_SCHEMA_VERSION}`);
	if (payload.source !== SOURCE) throw invalid(`source "${payload.source}", expected "${SOURCE}"`);
	if (!Array.isArray(payload.items)) throw invalid('items is not an array');
	const collection = payload.collection || {};
	const check = checkTdotRun({ ...collection, matched: Number.isFinite(collection.matched) ? collection.matched : payload.items.length }, thresholds);
	if (!check.ok) throw new TdotCollectError('TDOT_CANARY_FAILED', check.failures.map((f) => `${f.code} (${f.message})`).join('; '), check.failures);
	return payload;
}

// ParseHub's shape, parsed exactly as before (title before " -", last token
// is the sku, last duplicate of a tdot_code wins).
function parseParsehubRows(body) {
	const data = body && body.list1;
	if (!Array.isArray(data)) throw new Error("ParseHub answered an unexpected format: 'list1' not found");
	const results = [];
	for (const item of data) {
		for (const t of item.title || []) {
			const name = t.name || '';
			const price = parseFloat(String(t.price || '').replace('C$', '').replace(',', ''));
			const tdotCode = name.split(' -')[0].trim();
			const sku = tdotCode.split(' ').pop();
			const brand = tdotCode.replace(sku, '').trim();
			results.push({ tdot_price: price, tdot_code: tdotCode, sku, brand, product_url: item.link || null });
		}
	}
	return Object.values(results.reduce((acc, row) => { acc[row.tdot_code] = row; return acc; }, {}));
}

function parsehubProject(env) {
	return String(env.PARSEHUB_TDOT_PROJECT || DEFAULT_PARSEHUB_PROJECT).trim();
}

async function fetchParsehubRows({ fetch, env, timeoutMs }) {
	const apiKey = String(env.PARSEHUB_API_KEY || '').trim();
	if (!apiKey) throw new Error('TDOT_SOURCE=parsehub needs PARSEHUB_API_KEY in the environment');
	const url = `https://www.parsehub.com/api/v2/projects/${encodeURIComponent(parsehubProject(env))}/last_ready_run/data?api_key=${encodeURIComponent(apiKey)}&format=json`;
	const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
	const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
	if (!res.ok) throw new Error(`ParseHub answered HTTP ${res.status}`);
	return parseParsehubRows(await res.json());
}

function createTdotSource({
	prisma, env = process.env, fetch = globalThis.fetch, logger = console, sleep, now, withRetry, withConcurrency,
	labels, writeSnapshot = defaultWriteSnapshot, readSnapshot = defaultReadSnapshot,
} = {}) {
	const useParsehub = String(env.TDOT_SOURCE || '').toLowerCase() === 'parsehub';

	async function loadTargets() {
		return prisma.product.findMany({ where: TARGET_WHERE, select: TARGET_SELECT });
	}

	// What IngestRun.sourceRef records for this run.
	function describe() {
		return useParsehub ? `parsehub:${parsehubProject(env)}` : KLEVU_SOURCE_REF;
	}

	// rows: the legacy contract; payload: the collector's snapshot (null for
	// ParseHub); snapshotPath: where it went (the file read, for --from-snapshot).
	async function fetchRows({ dryRun = false, runId = null, fromSnapshot = null } = {}) {
		// Snapshot and ParseHub paths make no Klevu request: no User-Agent needed.
		const offline = getTdotOfflineConfig(env);
		if (fromSnapshot) {
			const payload = validateSnapshot(readSnapshot(fromSnapshot), offline.thresholds);
			logger.info(`[tdot] snapshot ${fromSnapshot} accepted: ${payload.items.length} items from run ${payload.runId == null ? 'manual' : payload.runId} captured ${payload.capturedAt}`);
			return { rows: toLegacyRows(payload), payload, snapshotPath: fromSnapshot };
		}
		if (useParsehub) {
			logger.warn('[tdot] TDOT_SOURCE=parsehub: reading the last ParseHub run (cutover escape hatch)');
			return { rows: await fetchParsehubRows({ fetch, env, timeoutMs: offline.timeoutMs }), payload: null, snapshotPath: null };
		}

		const config = getTdotConfig(env);
		const targets = await loadTargets();
		const { payload } = await collectTdot({
			fetch, config, targets, labels: labels || loadLabels(), runId, logger,
			sleep: sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			now, withRetry: withRetry || require('../../../lib/ingest/withRetry').withRetry,
			withConcurrency: withConcurrency || require('../../../lib/ingest/withRetry').withConcurrency,
		});
		const snapshotPath = writeSnapshot(payload, { dryRun, runId });
		logger.info(`[tdot] snapshot written: ${snapshotPath}${dryRun ? ' (dry-run)' : ''}`);
		return { rows: toLegacyRows(payload), payload, snapshotPath };
	}

	return { fetchRows, loadTargets, describe };
}

// Legacy entry point: same name and shape seed-tdot.js always used.
async function tdotCost(options = {}) {
	tdotCost.last = null;
	const prisma = require('../../../lib/prisma');
	const result = await createTdotSource({ prisma }).fetchRows(options);
	tdotCost.last = result;
	return result.rows;
}

module.exports = tdotCost;
module.exports.tdotCost = tdotCost;
module.exports.createTdotSource = createTdotSource;
module.exports.parseParsehubRows = parseParsehubRows;
module.exports.SNAPSHOT_FILE = SNAPSHOT_FILE;
module.exports.SNAPSHOT_DIR = SNAPSHOT_DIR;
module.exports.snapshotFileName = snapshotFileName;
module.exports.validateSnapshot = validateSnapshot;
