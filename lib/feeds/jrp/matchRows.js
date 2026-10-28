// Matches parsed JRP rows to our catalog. Rule: BRAND label -> jj_prefix,
// optional OEMSKU strip per prefix, then the brand-agnostic part number match
// over the products whose sku starts with `${prefix}-`. JRPSKU is never used
// to match. Two feed rows can land on one product (Holley 12-125 and 121-25
// both canonicalize to 12125): at most one is kept per product, the others
// are listed as feed collisions and never written. Pure apart from the injected
// loadProductsForPrefix, which is called once per active prefix present in
// the rows.

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

	const partNumber = partNumberFor(row, prefix, oemStrip);
	const match = matchPartNumber(indexes.get(prefix), partNumber);
	if (match.status === 'unmatched') return { kind: 'unmatched', entry: { ...identity(row), reason: 'no-sku-match' } };
	const ambiguous = match.status === 'ambiguous';
	const otherCandidates = ambiguous ? match.candidates.map((c) => c.sku).filter((sku) => sku !== match.sku) : [];
	const product = match.candidates.find((c) => c.sku === match.sku);
	return { kind: 'matched', entry: { ...row, prefix, productSku: match.sku, exact: isExact(partNumber, product, prefix), ambiguous, ...(ambiguous ? { otherCandidates } : {}) } };
}

// "Exact": the part number equals the product's searchable_sku as written
// (trimmed, case-insensitive), or the product sku minus its prefix.
function isExact(partNumber, product, prefix) {
	const wanted = partNumber.toUpperCase();
	const searchable = String(product.searchable_sku ?? '').trim().toUpperCase();
	const fromSku = String(product.sku ?? '').toUpperCase().replace(`${prefix.toUpperCase()}-`, '');
	return wanted === searchable || wanted === fromSku;
}

// Among the feed rows that landed on one product, only an exact row may be
// written: separators are the one thing that tells 12-125 from 121-25, so
// with no exact row (or more than one) nothing is written for that product
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
		.map((entry) => ({ ...identity(entry), productSku: entry.productSku, keptJrpSku: winner.get(entry.productSku)?.jrpSku ?? null, reason: 'feed-collision' }));
	return { kept, collisions };
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
	const { kept, collisions } = resolveCollisions(buckets.matched);
	const ambiguous = kept
		.filter((entry) => entry.ambiguous)
		.map((entry) => ({ ...identity(entry), productSku: entry.productSku, otherCandidates: entry.otherCandidates }));
	return {
		matched: kept,
		unmatched: buckets.unmatched,
		inactive: buckets.inactive,
		ambiguous,
		ambiguousCount: ambiguous.length,
		collisions,
		collisionCount: collisions.length,
	};
}

module.exports = { matchRows, partNumberFor };
