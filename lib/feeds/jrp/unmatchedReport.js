// Bodies and object keys of the per-run JRP report (unmatched, inactive and
// stale lists). Pure: the upload goes through the injected feed store. The key
// is deterministic from the run id because IngestRun has no column to hold it.

const { FEED_ID } = require('../../../config/jrp');

const SAMPLE_SIZE = 25;
const CSV_COLUMNS = ['list', 'brand_label', 'jrpsku', 'oemsku', 'product_sku', 'reason'];
const STALE_REASON = 'missing-from-feed';
// Spreadsheet apps run a cell that starts with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function reportKeys({ keyPrefix, runId }) {
	if (!keyPrefix) throw new Error('reportKeys requires a keyPrefix');
	if (runId === null || runId === undefined || runId === '') throw new Error('reportKeys requires a runId');
	const folder = `${keyPrefix}/${FEED_ID}/reports/${runId}`;
	return { json: `${folder}/unmatched.json`, csv: `${folder}/unmatched.csv` };
}

function buildReportJson({ runId, generatedAt, counts = {}, unmatched, inactive, stale }) {
	return JSON.stringify({
		feed: FEED_ID,
		runId,
		generatedAt: generatedAt.toISOString(),
		counts: { ...counts, unmatched: unmatched.length, inactive: inactive.length, stale: stale.length },
		unmatched,
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

function buildReportCsv({ unmatched, inactive, stale }) {
	const lines = [
		csvLine(CSV_COLUMNS),
		...unmatched.map((u) => csvLine(['unmatched', u.brandLabel, u.jrpSku, u.oemSku, '', u.reason])),
		...inactive.map((i) => csvLine(['inactive', i.brandLabel, i.jrpSku, i.oemSku, '', i.reason])),
		...stale.map((s) => csvLine(['stale', '', s.vendorSku, '', s.productSku, STALE_REASON])),
	];
	return `${lines.join('\n')}\n`;
}

function formatSample(unmatched) {
	return unmatched
		.slice(0, SAMPLE_SIZE)
		.map((u) => `${u.brandLabel} | ${u.jrpSku} | ${u.oemSku} | ${u.reason}`);
}

module.exports = { reportKeys, buildReportJson, buildReportCsv, formatSample, SAMPLE_SIZE };
