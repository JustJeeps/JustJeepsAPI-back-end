// Raw Klevu record -> collector item (DD-019 section 4). Pure: no env, no
// prisma, no I/O. A record carries `price`, `salePrice` and `oldPrice`; with
// no promotion the three are equal, so the selling price is salePrice when it
// is lower than price, else price. Display text is never parsed.

const INVALID_SAMPLE_LIMIT = 25;
const NAME_SEPARATOR = ' - ';

function asText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

// "Bestop 52401-11 - Sun Bikini Top" -> "Bestop 52401-11": the same shape as
// our Product.tdot_code. Fallback: the sku "Bestop-52401-11" with its first
// hyphen turned into a space.
function tdotCodeFromRecord(record) {
	const name = asText(record && record.name);
	if (name.includes(NAME_SEPARATOR)) return name.split(NAME_SEPARATOR)[0].trim();
	const sku = asText(record && record.sku);
	return sku ? sku.replace('-', ' ') : '';
}

function partNumberFromSku(sku) {
	const text = asText(sku);
	const dash = text.indexOf('-');
	return dash === -1 ? text : text.slice(dash + 1);
}

function normalizeRecord(raw, { maxPrice }) {
	if (!raw || typeof raw !== 'object') return { item: null, reason: 'not-an-object' };
	const competitorSku = tdotCodeFromRecord(raw);
	const skuToken = asText(raw.sku);
	if (!competitorSku) return { item: null, reason: 'no-part-number' };
	const currency = asText(raw.currency) || 'CAD';
	if (currency !== 'CAD') return { item: null, reason: 'currency-mismatch' };

	const regularPrice = asNumber(raw.price);
	const saleValue = asNumber(raw.salePrice);
	const salePrice = saleValue > 0 && saleValue < regularPrice ? saleValue : null;
	const effectivePrice = salePrice === null ? (regularPrice > 0 ? regularPrice : saleValue) : salePrice;
	if (!(effectivePrice > 0) || effectivePrice > maxPrice) return { item: null, reason: 'invalid-price' };

	return {
		reason: null,
		item: {
			sourceId: asText(raw.id) || null,
			competitorSku,
			skuToken: skuToken || null,
			partNumber: skuToken ? partNumberFromSku(skuToken) : competitorSku.split(' ').pop(),
			title: asText(raw.name),
			regularPrice,
			salePrice,
			effectivePrice,
			oldPrice: asNumber(raw.oldPrice) || null,
			discount: asText(raw.discount) || null,
			rawPrice: { price: asText(raw.price), salePrice: asText(raw.salePrice), oldPrice: asText(raw.oldPrice) },
			currency,
			url: asText(raw.url) || null,
			inStock: asText(raw.inStock).toLowerCase() === 'yes',
		},
	};
}

// Klevu lists category hits ("categoryid_505", no sku) among the products.
const isCategoryRecord = (raw) => Boolean(raw) && typeof raw.id === 'string' && raw.id.startsWith('categoryid_');

function normalizeRecords(records, { maxPrice = 20000 } = {}) {
	const items = [];
	const invalidSample = [];
	let invalidCount = 0;
	let categoryCount = 0;
	for (const raw of records || []) {
		if (isCategoryRecord(raw)) {
			categoryCount += 1;
			continue;
		}
		const { item, reason } = normalizeRecord(raw, { maxPrice });
		if (item) {
			items.push(item);
			continue;
		}
		invalidCount += 1;
		if (invalidSample.length < INVALID_SAMPLE_LIMIT) {
			invalidSample.push({ reason, sourceId: raw && raw.id ? asText(raw.id) : null, sku: raw ? asText(raw.sku) : '' });
		}
	}
	return { items, invalidCount, invalidSample, categoryCount };
}

function canonicalKey(value) {
	return String(value ?? '').trim().toUpperCase().replace(/[-_\s]/g, '');
}

// Two listings for the same part (brand crawl and per-product query can both
// return it): keep the cheaper one and count the duplicate.
function dedupeItems(items) {
	const byKey = new Map();
	let duplicateCount = 0;
	for (const item of items) {
		const key = canonicalKey(item.competitorSku);
		const current = byKey.get(key);
		if (!current) {
			byKey.set(key, item);
			continue;
		}
		duplicateCount += 1;
		if (item.effectivePrice < current.effectivePrice) byKey.set(key, item);
	}
	return { items: [...byKey.values()], duplicateCount };
}

module.exports = { tdotCodeFromRecord, normalizeRecord, normalizeRecords, dedupeItems, isCategoryRecord };
