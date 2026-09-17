// Brand-agnostic part number matcher. Sources disagree on separators
// (2620_RED vs 2620-RED vs 28230RED) but never on dots (330.20 vs 33020 are
// different parts), so the canonical form strips [-_ ] and keeps everything else.

function canonicalPartNumber(value) {
	return String(value ?? '').trim().toUpperCase().replace(/[-_\s]/g, '');
}

function buildProductIndex(products) {
	const index = new Map();
	for (const product of products || []) {
		const key = canonicalPartNumber(product.searchable_sku);
		if (!key) continue;
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(product);
	}
	return index;
}

// Tie-break, in order: raw uppercase equality with searchable_sku, then an
// active product (status 1), then the smallest sku. Same input, same answer.
function pickCandidate(candidates, partNumber) {
	const upper = String(partNumber ?? '').trim().toUpperCase();
	const rank = (p) => [
		String(p.searchable_sku ?? '').toUpperCase() === upper ? 0 : 1,
		p.status === 1 ? 0 : 1,
		String(p.sku ?? ''),
	];
	return [...candidates].sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra[0] !== rb[0]) return ra[0] - rb[0];
		if (ra[1] !== rb[1]) return ra[1] - rb[1];
		return ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0;
	})[0];
}

function matchPartNumber(index, partNumber) {
	const key = canonicalPartNumber(partNumber);
	const candidates = key ? index.get(key) || [] : [];
	if (candidates.length === 0) return { status: 'unmatched', sku: null, candidates: [] };
	if (candidates.length === 1) return { status: 'matched', sku: candidates[0].sku, candidates };
	return { status: 'ambiguous', sku: pickCandidate(candidates, partNumber).sku, candidates };
}

module.exports = { canonicalPartNumber, buildProductIndex, matchPartNumber };
