// Bodies and object keys of the per-run Grandwest report. Pure: the upload
// goes through the injected feed store. Reports live OUTSIDE the feeds/
// prefix (the retention prune deletes uncatalogued objects under feeds/).
// Brands we do not carry are most of the file (about 15k rows), so they are
// counted per line code instead of listed.

const { FEED_ID } = require('../../../config/grandwest');

const DEFAULT_REPORT_PREFIX = 'reports';
const SAMPLE_SIZE = 25;
const CSV_COLUMNS = ['list', 'line_code', 'item', 'product_sku', 'reason'];
// Spreadsheet apps run a cell that starts with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function reportKeys({ runId, reportPrefix = DEFAULT_REPORT_PREFIX }) {
	if (runId === null || runId === undefined || runId === '') throw new Error('reportKeys requires a runId');
	const folder = `${reportPrefix}/${FEED_ID}/${runId}`;
	return { json: `${folder}/report.json`, csv: `${folder}/report.csv` };
}

function countByLineCode(entries) {
	return entries.reduce((acc, { lineCode }) => ({ ...acc, [lineCode]: (acc[lineCode] || 0) + 1 }), {});
}

function buildReportJson({ runId, generatedAt, counts = {}, unmatched, invalid, duplicates, collisions, ambiguous, stale, notCarried }) {
	return JSON.stringify({
		feed: FEED_ID,
		runId,
		generatedAt: generatedAt.toISOString(),
		counts: { ...counts, notCarried: notCarried.length },
		notCarriedByLineCode: countByLineCode(notCarried),
		unmatched,
		invalid,
		duplicates,
		collisions,
		ambiguous,
		stale,
	});
}

function csvCell(value) {
	const s = String(value ?? '');
	const safe = FORMULA_START.test(s) ? `'${s}` : s;
	return `"${safe.replace(/"/g, '""')}"`;
}

const csvLine = (values) => values.map(csvCell).join(',');

function buildReportCsv({ unmatched, invalid, duplicates, collisions, ambiguous, stale }) {
	const lines = [
		csvLine(CSV_COLUMNS),
		...unmatched.map((u) => csvLine(['unmatched', u.lineCode, u.item, '', u.reason])),
		...invalid.map((i) => csvLine(['invalid', i.lineCode, i.item, '', i.reason])),
		...duplicates.map((d) => csvLine(['duplicate', d.lineCode, d.item, '', `${d.reason}:${d.copies}-copies`])),
		...collisions.map((c) => csvLine(['collision', c.lineCode, c.item, c.productSku, `${c.reason}:${c.keptItem ? `kept=${c.keptItem}` : 'unresolved'}`])),
		...ambiguous.map((a) => csvLine(['ambiguous', a.lineCode, a.item, a.productSku, `ambiguous:${(a.otherCandidates || []).join('|')}`])),
		...stale.map((s) => csvLine(['stale', '', s.vendorSku, s.productSku, s.reason])),
	];
	return `${lines.join('\n')}\n`;
}

// A few unmatched rows per line code, so one big brand cannot fill the sample.
function formatSample(unmatched) {
	const byLineCode = new Map();
	for (const row of unmatched) byLineCode.set(row.lineCode, [...(byLineCode.get(row.lineCode) || []), row]);
	const queues = [...byLineCode.keys()].sort().map((code) => byLineCode.get(code));
	const longest = Math.max(0, ...queues.map((queue) => queue.length));
	return Array.from({ length: longest }, (_, depth) => queues.filter((queue) => depth < queue.length).map((queue) => queue[depth]))
		.flat()
		.slice(0, SAMPLE_SIZE)
		.map((u) => `${u.lineCode} | ${u.item} | tried ${u.prefix}-${u.part}`);
}

module.exports = { reportKeys, buildReportJson, buildReportCsv, formatSample, SAMPLE_SIZE };
