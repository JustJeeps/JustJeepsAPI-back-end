// Bodies and object keys of the per-run JRP report (unmatched, ambiguous,
// inactive and stale lists). Pure: the upload goes through the injected feed store. The key
// is deterministic from the run id because IngestRun has no column to hold it.
// Reports live OUTSIDE the feeds/ prefix (like run logs under logs/): the
// retention prune deletes uncatalogued objects under feeds/<feed>/ after 24h.

const { FEED_ID } = require('../../../config/jrp');

const DEFAULT_REPORT_PREFIX = 'reports';
const SAMPLE_SIZE = 25;
const CSV_COLUMNS = ['list', 'brand_label', 'jrpsku', 'oemsku', 'product_sku', 'reason'];
const STALE_REASON = 'missing-from-feed';
const AMBIGUOUS_REASON = 'ambiguous';
// Spreadsheet apps run a cell that starts with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function reportKeys({ runId, reportPrefix = DEFAULT_REPORT_PREFIX }) {
	if (!reportPrefix) throw new Error('reportKeys requires a reportPrefix');
	if (runId === null || runId === undefined || runId === '') throw new Error('reportKeys requires a runId');
	const folder = `${reportPrefix}/${FEED_ID}/${runId}`;
	return { json: `${folder}/unmatched.json`, csv: `${folder}/unmatched.csv` };
}

function buildReportJson({ runId, generatedAt, counts = {}, unmatched, ambiguous = [], inactive, stale }) {
	return JSON.stringify({
		feed: FEED_ID,
		runId,
		generatedAt: generatedAt.toISOString(),
		counts: { ...counts, unmatched: unmatched.length, ambiguous: ambiguous.length, inactive: inactive.length, stale: stale.length },
		unmatched,
		ambiguous,
		inactive,
		stale,
	});
}

function csvCell(value) {
	const s = String(value ?? '');
	const safe = FORMULA_START.test(s) ? `'${s}` : s;
	return `"${safe.replace(/"/g, '""')}"`;
}

const csvLine = (values) => values.map(csvCell).join(',');

// The chosen product goes in product_sku; the reason names the candidates
// that lost the tie-break, so a reviewer can check the pick.
const ambiguousReason = (a) => `${AMBIGUOUS_REASON}:${(a.otherCandidates || []).join('|')}`;

function buildReportCsv({ unmatched, ambiguous = [], inactive, stale }) {
	const lines = [
		csvLine(CSV_COLUMNS),
		...unmatched.map((u) => csvLine(['unmatched', u.brandLabel, u.jrpSku, u.oemSku, '', u.reason])),
		...ambiguous.map((a) => csvLine(['ambiguous', a.brandLabel, a.jrpSku, a.oemSku, a.productSku, ambiguousReason(a)])),
		...inactive.map((i) => csvLine(['inactive', i.brandLabel, i.jrpSku, i.oemSku, '', i.reason])),
		...stale.map((s) => csvLine(['stale', '', s.vendorSku, '', s.productSku, STALE_REASON])),
	];
	return `${lines.join('\n')}\n`;
}

const MAPPING_GAP = 'no-brand-mapping';

// Interleaves rows across brand labels (sorted, rows in feed order within a
// brand), so one large brand cannot fill every slot.
function roundRobinByBrand(rows) {
	const byBrand = new Map();
	for (const row of rows) {
		const label = String(row.brandLabel ?? '');
		byBrand.set(label, [...(byBrand.get(label) || []), row]);
	}
	const queues = [...byBrand.keys()].sort((a, b) => a.localeCompare(b, 'en')).map((label) => byBrand.get(label));
	const longest = Math.max(0, ...queues.map((queue) => queue.length));
	return Array.from({ length: longest }, (_, depth) => queues.filter((queue) => depth < queue.length).map((queue) => queue[depth])).flat();
}

// Mapping gaps first: an unmapped label is the signal for a brand JRP just
// approved. The rest of the slots go round-robin across brand labels.
function pickSample(unmatched) {
	const gaps = unmatched.filter((u) => u.reason === MAPPING_GAP);
	const others = unmatched.filter((u) => u.reason !== MAPPING_GAP);
	return [...roundRobinByBrand(gaps), ...roundRobinByBrand(others)].slice(0, SAMPLE_SIZE);
}

function formatSample(unmatched) {
	return pickSample(unmatched).map((u) => `${u.brandLabel} | ${u.jrpSku} | ${u.oemSku} | ${u.reason}`);
}

module.exports = { reportKeys, buildReportJson, buildReportCsv, formatSample, SAMPLE_SIZE };
