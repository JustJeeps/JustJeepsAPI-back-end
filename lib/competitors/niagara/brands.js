// The brands we scrape on Niagara Jeeps (DD-021), read from the rows of
// vendors_prefix.js that carry a niagara_code (the Shopify collection handle,
// where to crawl) and optionally niagara_sku_prefixes (literal text Niagara
// puts before the part number for that brand, e.g. "RHI-" for Go Rhino or
// "RCS" for Rough Country; measured against our catalog on 2026-11-02).
// Mirrors brandLabelToPrefix in config/jrp.js. Pure.

const clean = (value) => String(value ?? '').trim();

function niagaraBrands(vendorsPrefix) {
	return (vendorsPrefix || [])
		.filter((row) => clean(row.niagara_code) && clean(row.jj_prefix))
		.map((row) => ({
			jjPrefix: clean(row.jj_prefix),
			brandName: clean(row.brand_name),
			handle: clean(row.niagara_code).toLowerCase(),
			skuPrefixes: (row.niagara_sku_prefixes || []).map((p) => clean(p).toUpperCase()).filter(Boolean),
		}));
}

// Sample runs (--brands=BIL,MOT) name jj_prefixes; an unknown one is a typo,
// so fail instead of silently crawling less.
function filterBrands(brands, wanted) {
	const list = (wanted || []).map((w) => clean(w).toUpperCase()).filter(Boolean);
	if (!list.length) return brands;
	const unknown = list.filter((w) => !brands.some((b) => b.jjPrefix.toUpperCase() === w));
	if (unknown.length) throw new Error(`not mapped to Niagara Jeeps: ${unknown.join(', ')}`);
	return brands.filter((b) => list.includes(b.jjPrefix.toUpperCase()));
}

module.exports = { niagaraBrands, filterBrands };
