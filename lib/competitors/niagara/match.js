// Niagara Jeeps item -> our Product (DD-021). Niagara's SKU is either the bare
// manufacturer part number (24-352925) or that number behind a code of theirs
// (BIL-24-352925, RHI-..., RCS55658). We try the raw SKU first and then the SKU
// without each prefix configured for the brand (niagara_sku_prefixes), always
// inside that brand's products, with the shared canonical matcher (separators
// ignored, dots kept). One row per product of ours: a second Niagara SKU on the
// same product is a collision (exact spelling first, then the bare spelling,
// never the price), and one Niagara sku matched in two brands is written for
// neither.
// Pure.

const { buildProductIndex, matchPartNumber } = require('../skuMatch');

const usable = (sku) => {
	const text = String(sku ?? '').trim();
	return text !== '' && !text.endsWith('-');
};

function buildIndexes(products) {
	const groups = new Map();
	for (const product of products || []) {
		if (!usable(product.searchable_sku)) continue;
		if (!groups.has(product.jj_prefix)) groups.set(product.jj_prefix, []);
		groups.get(product.jj_prefix).push(product);
	}
	return new Map([...groups].map(([prefix, list]) => [prefix, buildProductIndex(list)]));
}

function candidatePartNumbers(sku, skuPrefixes) {
	const text = String(sku ?? '').trim();
	const upper = text.toUpperCase();
	const stripped = (skuPrefixes || [])
		.filter((p) => upper.startsWith(p) && upper.length > p.length)
		.map((p) => ({ partNumber: text.slice(p.length), via: `prefix:${p}` }));
	return [{ partNumber: text, via: 'raw' }, ...stripped];
}

function firstMatch(index, candidates) {
	for (const candidate of candidates) {
		const match = matchPartNumber(index, candidate.partNumber);
		if (match.status !== 'unmatched') return { ...candidate, match };
	}
	return null;
}

const isExact = (hit) => hit.match.candidates.some((p) => p.sku === hit.match.sku
	&& String(p.searchable_sku).trim().toUpperCase() === hit.partNumber.trim().toUpperCase());

// Stable on purpose: rows are keyed on competitor_sku and never deleted, so a
// winner that changed with the price would leave the previous winner's row
// behind with a frozen price. Price only breaks a tie between two listings of
// the very same spelling, which write the same row either way.
const viaRaw = (entry) => entry.hit.via === 'raw';
function better(a, b) {
	if (a.exact !== b.exact) return a.exact ? a : b;
	if (viaRaw(a) !== viaRaw(b)) return viaRaw(a) ? a : b;
	if (a.item.competitorSku !== b.item.competitorSku) return a.item.competitorSku < b.item.competitorSku ? a : b;
	return a.item.price <= b.item.price ? a : b;
}

// CompetitorProduct is keyed on competitor_sku alone. The same Niagara sku
// matched in two brands would be two rows under one key, and the nightly
// update would then swap prices between our products, so neither is written.
function dropSharedSkus(winners, collisions, stats) {
	const byCompetitorSku = new Map();
	for (const entry of winners) {
		const list = byCompetitorSku.get(entry.item.competitorSku) || [];
		byCompetitorSku.set(entry.item.competitorSku, [...list, entry]);
	}
	const kept = [];
	for (const list of byCompetitorSku.values()) {
		if (list.length === 1) {
			kept.push(list[0]);
			continue;
		}
		for (const entry of list) {
			collisions.push({ competitorSku: entry.item.competitorSku, productSku: entry.hit.match.sku, keptSku: '', reason: 'same-sku-in-two-brands' });
			stats(entry.item.jjPrefix).collisions += 1;
		}
	}
	return kept;
}

function emptyStats() {
	return { items: 0, matched: 0, unmatched: 0, viaPrefix: 0, collisions: 0 };
}

function matchItems(items, { indexes, brands }) {
	const prefixesOf = new Map((brands || []).map((b) => [b.jjPrefix, b.skuPrefixes || []]));
	const byBrand = {};
	const stats = (prefix) => {
		if (!byBrand[prefix]) byBrand[prefix] = emptyStats();
		return byBrand[prefix];
	};
	const unmatched = [];
	const ambiguous = [];
	const winners = new Map();
	const collisions = [];

	for (const item of items) {
		const brandStats = stats(item.jjPrefix);
		brandStats.items += 1;
		const index = indexes.get(item.jjPrefix);
		const hit = index ? firstMatch(index, candidatePartNumbers(item.competitorSku, prefixesOf.get(item.jjPrefix))) : null;
		if (!hit) {
			brandStats.unmatched += 1;
			unmatched.push({ jjPrefix: item.jjPrefix, competitorSku: item.competitorSku, url: item.url });
			continue;
		}
		if (hit.match.status === 'ambiguous') {
			ambiguous.push({ competitorSku: item.competitorSku, chosen: hit.match.sku, candidates: hit.match.candidates.map((c) => c.sku) });
		}
		const entry = { item, hit, exact: isExact(hit) };
		const current = winners.get(hit.match.sku);
		if (!current) {
			winners.set(hit.match.sku, entry);
			continue;
		}
		const kept = better(current, entry);
		const lost = kept === current ? entry : current;
		winners.set(hit.match.sku, kept);
		collisions.push({ competitorSku: lost.item.competitorSku, productSku: hit.match.sku, keptSku: kept.item.competitorSku, reason: 'same-product' });
		stats(lost.item.jjPrefix).collisions += 1;
	}

	const rows = [];
	for (const { item, hit } of dropSharedSkus([...winners.values()], collisions, stats)) {
		const brandStats = stats(item.jjPrefix);
		brandStats.matched += 1;
		if (hit.via !== 'raw') brandStats.viaPrefix += 1;
		rows.push({ product_sku: hit.match.sku, competitor_sku: item.competitorSku, competitor_price: item.price, product_url: item.url });
	}
	return { rows, unmatched, ambiguous, collisions, byBrand };
}

module.exports = { buildIndexes, matchItems, candidatePartNumbers };
