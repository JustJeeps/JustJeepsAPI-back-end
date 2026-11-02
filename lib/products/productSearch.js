// Where clause of the Items screen search (GET /api/products?search=).
// Besides our own SKU, name, brand and searchable SKU, it matches any vendor's
// SKU: purchasers often hold only the vendor's code (JRP writes BIL33-292984
// for our BIL-33-292984). Costs ~250ms more per search on prod (EXISTS over
// ~160k VendorProduct rows, measured 2026-11-02); add a trigram index if
// that grows.

function buildProductSearchWhere(search) {
	const clean = String(search ?? '').trim();
	if (!clean) return {};
	const term = { contains: clean, mode: 'insensitive' };
	return {
		OR: [
			{ sku: term },
			{ name: term },
			{ brand_name: term },
			{ searchable_sku: term },
			{ vendorProducts: { some: { vendor_sku: term } } },
		],
	};
}

module.exports = { buildProductSearchWhere };
