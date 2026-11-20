// The brands we scrape on a Shopify competitor (DD-021, DD-022), read from the
// rows of vendors_prefix.js that carry the store's handle field (the Shopify
// collection handle, where to crawl, e.g. niagara_code) and optionally its
// prefixes field (literal text the store puts before the part number for that
// brand, e.g. niagara_sku_prefixes "RHI-" for Go Rhino; measured against our
// catalog). Mirrors brandLabelToPrefix in config/jrp.js. Pure.

const clean = (value) => String(value ?? '').trim();

function readStoreBrands(profile, vendorsPrefix) {
	const { handleField, prefixesField } = profile.mapping;
	return (vendorsPrefix || [])
		.filter((row) => clean(row[handleField]) && clean(row.jj_prefix))
		.map((row) => ({
			jjPrefix: clean(row.jj_prefix),
			brandName: clean(row.brand_name),
			handle: clean(row[handleField]).toLowerCase(),
			skuPrefixes: (row[prefixesField] || []).map((p) => clean(p).toUpperCase()).filter(Boolean),
		}));
}

// Sample runs (--brands=BIL,MOT) name jj_prefixes; an unknown one is a typo,
// so fail instead of silently crawling less.
function filterStoreBrands(profile, brands, wanted) {
	const list = (wanted || []).map((w) => clean(w).toUpperCase()).filter(Boolean);
	if (!list.length) return brands;
	const unknown = list.filter((w) => !brands.some((b) => b.jjPrefix.toUpperCase() === w));
	if (unknown.length) throw new Error(`not mapped to ${profile.competitor.name}: ${unknown.join(', ')}`);
	return brands.filter((b) => list.includes(b.jjPrefix.toUpperCase()));
}

function createBrandReader(profile) {
	return {
		readBrands: (vendorsPrefix) => readStoreBrands(profile, vendorsPrefix),
		filterBrands: (brands, wanted) => filterStoreBrands(profile, brands, wanted),
	};
}

module.exports = { createBrandReader };
