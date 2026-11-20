// Per-run review report for Niagara Jeeps (DD-021): what was not written and
// why (unmatched, collision, ambiguous pick), as a CSV for a spreadsheet.
// Pure.

const { toCsv } = require('./csv');

const COLUMNS = ['list', 'jj_prefix', 'competitor_sku', 'product_sku', 'detail', 'url'];

const collisionDetail = (c) => (c.reason === 'same-sku-in-two-brands' ? 'same sku matched in two brands: not written' : `kept ${c.keptSku}`);

function buildReportCsv({ unmatched = [], collisions = [], ambiguous = [] }) {
	const rows = [
		...unmatched.map((u) => ({ list: 'unmatched', jj_prefix: u.jjPrefix, competitor_sku: u.competitorSku, url: u.url })),
		...collisions.map((c) => ({ list: 'collision', competitor_sku: c.competitorSku, product_sku: c.productSku, detail: collisionDetail(c) })),
		...ambiguous.map((a) => ({ list: 'ambiguous', competitor_sku: a.competitorSku, product_sku: a.chosen, detail: `candidates ${a.candidates.join(' ')}` })),
	];
	return toCsv(COLUMNS, rows);
}

module.exports = { buildReportCsv };
