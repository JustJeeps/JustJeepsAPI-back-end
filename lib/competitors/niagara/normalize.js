// Shopify product -> Niagara Jeeps competitor items (DD-021). One item per
// variant that has a SKU: the SKU is the upsert key (competitor_sku) and the
// search term on their site. The link uses the handle from the JSON (it cannot
// be built from the SKU or the title) and ?variant= when there are several
// variants, so the page opens on the priced variant. Shopify's price is the
// live selling price; compare_at_price is kept for the snapshot only. Pure.

const toPrice = (value) => {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

function productUrl({ baseUrl, handle, variantId, variantCount }) {
	const url = `${baseUrl}/products/${handle}`;
	return variantCount > 1 && variantId ? `${url}?variant=${variantId}` : url;
}

function normalizeProduct(product, { baseUrl, maxPrice }) {
	const variants = Array.isArray(product.variants) ? product.variants : [];
	const handle = String(product.handle || '').trim();
	const items = [];
	const invalid = [];
	for (const variant of variants) {
		const competitorSku = String(variant.sku || '').trim();
		const price = toPrice(variant.price);
		const base = { productId: product.id, variantId: variant.id, competitorSku, price: variant.price };
		if (!handle) invalid.push({ ...base, reason: 'no-handle' });
		else if (!competitorSku) invalid.push({ ...base, reason: 'no-sku' });
		else if (price === null || price <= 0 || price > maxPrice) invalid.push({ ...base, reason: 'invalid-price' });
		else {
			items.push({
				competitorSku,
				price,
				regularPrice: toPrice(variant.compare_at_price),
				available: variant.available !== false,
				url: productUrl({ baseUrl, handle, variantId: variant.id, variantCount: variants.length }),
				productId: product.id,
				variantId: variant.id,
				vendor: String(product.vendor || '').trim(),
			});
		}
	}
	return { items, invalid };
}

const skuKey = (sku) => String(sku || '').trim().toUpperCase();

// The same SKU can be listed twice (two products, or two collections of one
// brand). Keep the cheaper copy, the price a customer would actually see.
function dedupeItems(items) {
	const kept = new Map();
	const duplicates = [];
	for (const item of items) {
		const key = skuKey(item.competitorSku);
		const current = kept.get(key);
		if (!current) kept.set(key, item);
		else if (item.price < current.price) {
			duplicates.push(current);
			kept.set(key, item);
		} else duplicates.push(item);
	}
	return { items: [...kept.values()], duplicates };
}

module.exports = { productUrl, normalizeProduct, dedupeItems, skuKey };
