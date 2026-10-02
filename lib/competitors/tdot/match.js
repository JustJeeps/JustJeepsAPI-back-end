// Product-driven matching (DD-019 section 2, data seat). We know every
// Product.tdot_code ("<label> <part>") before looking at TDOT; a TDOT item
// matches when its competitorSku canonicalizes to the same string. The row we
// emit carries OUR tdot_code, so seed-tdot's exact match holds by construction.
// Canonical = uppercase, strip [-_ ], keep dots (lib/competitors/skuMatch.js).

const { canonicalPartNumber } = require('../skuMatch');

function canonicalTdotCode(value) {
	return canonicalPartNumber(value);
}

// key -> products sharing that tdot_code (six TDOT labels are used by two jj
// prefixes, so a key can hold more than one product).
function buildTargetIndex(products) {
	const index = new Map();
	for (const product of products || []) {
		const key = canonicalTdotCode(product.tdot_code);
		if (!key) continue;
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(product);
	}
	return index;
}

function matchItems(items, index) {
	const matchedByKey = new Map();
	const unmatched = [];
	const ambiguous = [];
	let duplicateCount = 0;

	for (const item of items || []) {
		const key = canonicalTdotCode(item.competitorSku);
		const products = key ? index.get(key) : undefined;
		if (!products || products.length === 0) {
			unmatched.push(item);
			continue;
		}
		const current = matchedByKey.get(key);
		if (current) {
			duplicateCount += 1;
			// Prefer the listing spelled exactly like our tdot_code, then the cheapest.
			const exactNow = current.item.competitorSku === current.tdotCode;
			const exactNew = item.competitorSku === current.tdotCode;
			if ((exactNew && !exactNow) || (exactNew === exactNow && item.effectivePrice < current.item.effectivePrice)) current.item = item;
			continue;
		}
		const sorted = [...products].sort((a, b) => (b.status === 1) - (a.status === 1) || String(a.sku).localeCompare(String(b.sku)));
		const primary = sorted[0];
		matchedByKey.set(key, { tdotCode: primary.tdot_code, productSku: primary.sku, item });
		if (products.length > 1) {
			ambiguous.push({ tdotCode: primary.tdot_code, productSkus: sorted.map((p) => p.sku) });
		}
	}

	return { matched: [...matchedByKey.values()], unmatched, ambiguous, duplicateCount };
}

module.exports = { canonicalTdotCode, buildTargetIndex, matchItems };
