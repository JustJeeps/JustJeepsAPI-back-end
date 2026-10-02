// Payload v1 -> the rows prisma/seeds/api-calls/tdot-api.js always returned,
// so prisma/seeds/seed-individual/seed-tdot.js keeps its contract:
// { tdot_price, tdot_code, sku, brand, product_url }. tdot_code is OUR
// Product.tdot_code (what seed-tdot matches on), never TDOT's wording.

function brandOf(tdotCode, partNumber) {
	const code = String(tdotCode ?? '');
	const part = String(partNumber ?? '');
	if (part && code.endsWith(` ${part}`)) return code.slice(0, -(part.length + 1)).trim();
	return code.split(' ')[0];
}

function toLegacyRows(payload) {
	return ((payload && payload.items) || []).map((item) => ({
		tdot_price: item.effectivePrice,
		tdot_code: item.tdotCode,
		sku: item.partNumber,
		brand: brandOf(item.tdotCode, item.partNumber),
		product_url: item.url || null,
	}));
}

module.exports = { toLegacyRows };
