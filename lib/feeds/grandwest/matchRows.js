// Matches parsed Grandwest rows to products we already have. Rule: LineCode ->
// jj_prefix through vendors_prefix.grandwest_code (never by letters), the per
// brand part rewrite from config/grandwest.js, then the brand-agnostic part
// number match over the products whose sku starts with `${prefix}-`. A line
// code with no mapping is a brand we do not carry: skipped, never created.
// Two rows on one product keep only the exact one (same rule as JRP). Pure
// apart from the injected loadProductsForPrefix, called once per prefix
// present in the rows.

const { buildProductIndex, matchPartNumber } = require('../../competitors/skuMatch');
const { partNumberFor } = require('../../../config/grandwest');

const identity = (row) => ({ item: row.item, lineCode: row.lineCode });

async function loadIndexes(prefixes, loadProductsForPrefix) {
	const entries = [];
	for (const prefix of prefixes) {
		const products = await loadProductsForPrefix(prefix);
		entries.push([prefix, buildProductIndex(products)]);
	}
	return new Map(entries);
}

// "Exact": the part number equals the product's searchable_sku as written
// (trimmed, case-insensitive), or the product sku minus its prefix.
function isExact(partNumber, product, prefix) {
	const wanted = partNumber.toUpperCase();
	const searchable = String(product.searchable_sku ?? '').trim().toUpperCase();
	const fromSku = String(product.sku ?? '').toUpperCase().replace(`${prefix.toUpperCase()}-`, '');
	return wanted === searchable || wanted === fromSku;
}

function classify(row, { lineCodeToPrefix, indexes }) {
	const prefix = lineCodeToPrefix.get(row.lineCode);
	if (!prefix) return { kind: 'notCarried', entry: { ...identity(row), reason: 'brand-not-carried' } };

	const part = partNumberFor(row.lineCode, row.part);
	const match = matchPartNumber(indexes.get(prefix), part);
	if (match.status === 'unmatched') return { kind: 'unmatched', entry: { ...identity(row), prefix, part, reason: 'no-sku-match' } };
	const ambiguous = match.status === 'ambiguous';
	const product = match.candidates.find((c) => c.sku === match.sku);
	const otherCandidates = ambiguous ? match.candidates.map((c) => c.sku).filter((sku) => sku !== match.sku) : [];
	return {
		kind: 'matched',
		entry: { ...row, prefix, productSku: match.sku, exact: isExact(part, product, prefix), ambiguous, ...(ambiguous ? { otherCandidates } : {}) },
	};
}

// Among the rows that landed on one product, only an exact row may be
// written; with none (or more than one) nothing is written for that product
// and every row of the group is reported. Same input, same answer.
function resolveCollisions(matched) {
	const byProduct = new Map();
	for (const entry of matched) byProduct.set(entry.productSku, [...(byProduct.get(entry.productSku) || []), entry]);
	const winner = new Map([...byProduct].map(([productSku, group]) => {
		if (group.length === 1) return [productSku, group[0]];
		const exact = group.filter((entry) => entry.exact);
		return [productSku, exact.length === 1 ? exact[0] : null];
	}));
	const kept = matched.filter((entry) => winner.get(entry.productSku) === entry);
	const collisions = matched
		.filter((entry) => winner.get(entry.productSku) !== entry)
		.map((entry) => ({ ...identity(entry), productSku: entry.productSku, keptItem: winner.get(entry.productSku)?.item ?? null, reason: 'feed-collision' }));
	return { kept, collisions };
}

async function matchRows(rows, { lineCodeToPrefix, loadProductsForPrefix }) {
	const prefixes = [...new Set(rows.map((row) => lineCodeToPrefix.get(row.lineCode)).filter(Boolean))];
	const indexes = await loadIndexes(prefixes, loadProductsForPrefix);

	const buckets = { matched: [], unmatched: [], notCarried: [] };
	for (const row of rows) {
		const { kind, entry } = classify(row, { lineCodeToPrefix, indexes });
		buckets[kind].push(entry);
	}
	const { kept, collisions } = resolveCollisions(buckets.matched);
	const ambiguous = kept
		.filter((entry) => entry.ambiguous)
		.map((entry) => ({ ...identity(entry), productSku: entry.productSku, otherCandidates: entry.otherCandidates }));
	return { matched: kept, unmatched: buckets.unmatched, notCarried: buckets.notCarried, ambiguous, collisions };
}

// Per mapped line code: what matched and what did not. This is the check of
// the brand map against the real catalog, so it is logged on every run.
function summarizeByLineCode({ matched, unmatched, collisions }) {
	const summary = new Map();
	const bump = (lineCode, prefix, field) => {
		const current = summary.get(lineCode) || { lineCode, prefix, matched: 0, unmatched: 0, collisions: 0 };
		summary.set(lineCode, { ...current, [field]: current[field] + 1 });
	};
	matched.forEach((entry) => bump(entry.lineCode, entry.prefix, 'matched'));
	unmatched.forEach((entry) => bump(entry.lineCode, entry.prefix, 'unmatched'));
	collisions.forEach((entry) => bump(entry.lineCode, entry.productSku.split('-')[0], 'collisions'));
	const total = (s) => s.matched + s.unmatched + s.collisions;
	return [...summary.values()].sort((a, b) => total(b) - total(a) || a.lineCode.localeCompare(b.lineCode));
}

module.exports = { matchRows, summarizeByLineCode };
