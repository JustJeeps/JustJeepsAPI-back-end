// Matches parsed JRP rows to our catalog. Rule: BRAND label -> jj_prefix,
// optional OEMSKU strip per prefix, then the brand-agnostic part number match
// over the products whose sku starts with `${prefix}-`. JRPSKU is never used
// to match. Pure apart from the injected loadProductsForPrefix, which is
// called once per active prefix present in the rows.

const { buildProductIndex, matchPartNumber } = require('../../competitors/skuMatch');

const normalizeLabel = (label) => String(label ?? '').trim().toLowerCase();

const identity = (row) => ({ brandLabel: row.brandLabel, jrpSku: row.jrpSku, oemSku: row.oemSku });

function partNumberFor(row, prefix, oemStrip) {
	const pattern = oemStrip[prefix];
	if (!pattern) return row.oemSku;
	const stripped = row.oemSku.replace(pattern, '');
	return stripped || row.oemSku;
}

async function loadIndexes(prefixes, loadProductsForPrefix) {
	const entries = [];
	for (const prefix of prefixes) {
		const products = await loadProductsForPrefix(prefix);
		entries.push([prefix, buildProductIndex(products)]);
	}
	return new Map(entries);
}

function classify(row, { labelToPrefix, active, oemStrip, indexes }) {
	const prefix = labelToPrefix.get(normalizeLabel(row.brandLabel));
	if (!prefix) return { kind: 'unmatched', entry: { ...identity(row), reason: 'no-brand-mapping' } };
	if (!active.has(prefix)) return { kind: 'inactive', entry: { ...identity(row), prefix, reason: 'skipped-inactive' } };

	const match = matchPartNumber(indexes.get(prefix), partNumberFor(row, prefix, oemStrip));
	if (match.status === 'unmatched') return { kind: 'unmatched', entry: { ...identity(row), reason: 'no-sku-match' } };
	return { kind: 'matched', entry: { ...row, prefix, productSku: match.sku, ambiguous: match.status === 'ambiguous' } };
}

async function matchRows(rows, { labelToPrefix, activePrefixes, oemStrip = {}, loadProductsForPrefix }) {
	const active = new Set(activePrefixes);
	const prefixesInFeed = new Set(rows.map((row) => labelToPrefix.get(normalizeLabel(row.brandLabel))));
	const toLoad = [...active].filter((prefix) => prefixesInFeed.has(prefix));
	const indexes = await loadIndexes(toLoad, loadProductsForPrefix);

	const context = { labelToPrefix, active, oemStrip, indexes };
	const buckets = { matched: [], unmatched: [], inactive: [] };
	for (const row of rows) {
		const { kind, entry } = classify(row, context);
		buckets[kind].push(entry);
	}
	return {
		matched: buckets.matched,
		unmatched: buckets.unmatched,
		inactive: buckets.inactive,
		ambiguousCount: buckets.matched.filter((entry) => entry.ambiguous).length,
	};
}

module.exports = { matchRows, partNumberFor };
