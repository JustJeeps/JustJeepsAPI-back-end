// Raw PartsLogic item -> contract v1 row (DD-018 section 6). Pure: no env, no
// prisma, no I/O. The API returns `price` (regular) and `sale` (discounted or
// 0). Sales asked for the discounted price, so that is the effective one.

const SOURCE = 'lowriders';
const COMPETITOR = { name: 'Lowriders', website: 'https://www.lowriders.ca/' };
const BRAND_NAME = 'Rough Country';
const RCS_PREFIX = /^RCS-/i;
const INVALID_SAMPLE_LIMIT = 25;

function asText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

// stockid ("RCS-330.20") is faithful; dealerid ("330.2") is lossy. Title
// starts with "<part> | " on the listing. Order of trust: stockid, title, dealerid.
function extractPartNumber(raw) {
	const stockid = asText(raw.stockid);
	if (stockid) return stockid.replace(RCS_PREFIX, '');
	const fromTitle = asText(raw.title).split(' | ')[0].trim();
	if (fromTitle) return fromTitle;
	return asText(raw.dealerid);
}

function normalizeItem(raw, { maxPrice }) {
	if (!raw || typeof raw !== 'object') return { item: null, reason: 'not-an-object' };
	const partNumber = extractPartNumber(raw);
	if (!partNumber) return { item: null, reason: 'no-part-number' };

	const regularPrice = asNumber(raw.price);
	const saleValue = asNumber(raw.sale);
	const salePrice = saleValue > 0 ? saleValue : null;
	const effectivePrice = salePrice === null ? regularPrice : salePrice;
	if (!(effectivePrice > 0) || effectivePrice > maxPrice) return { item: null, reason: 'invalid-price' };

	return {
		reason: null,
		item: {
			sourceId: raw.id ?? null,
			stockId: asText(raw.stockid) || null,
			competitorSku: partNumber,
			partNumber,
			title: asText(raw.title),
			brandName: asText(raw.brand_name),
			regularPrice,
			salePrice,
			effectivePrice,
			currency: 'CAD',
			url: asText(raw.url) || null,
			availability: asText(raw.availability) || null,
		},
	};
}

function normalizeItems(rawList, { maxPrice = 20000 } = {}) {
	const items = [];
	const invalidSample = [];
	let invalidCount = 0;
	for (const raw of rawList || []) {
		const { item, reason } = normalizeItem(raw, { maxPrice });
		if (item) {
			items.push(item);
			continue;
		}
		invalidCount += 1;
		if (invalidSample.length < INVALID_SAMPLE_LIMIT) {
			invalidSample.push({ reason, sourceId: raw && raw.id ? raw.id : null, stockId: raw ? asText(raw.stockid) : '' });
		}
	}
	return { items, invalidCount, invalidSample };
}

// Two listings for the same part: keep the cheaper one (that is what a
// customer would see first) and count the duplicate for the canary.
function dedupeItems(items) {
	const bySku = new Map();
	let duplicateCount = 0;
	for (const item of items) {
		const current = bySku.get(item.competitorSku);
		if (!current) {
			bySku.set(item.competitorSku, item);
			continue;
		}
		duplicateCount += 1;
		if (item.effectivePrice < current.effectivePrice) bySku.set(item.competitorSku, item);
	}
	return { items: [...bySku.values()], duplicateCount };
}

function buildPayload({
	items, runId, capturedAt, reportedTotal, pagesFetched, pageSize, configSource, invalidCount, duplicateCount, brandId,
}) {
	return {
		schemaVersion: 1,
		source: SOURCE,
		competitor: { ...COMPETITOR },
		brand: { name: BRAND_NAME, sourceBrandId: brandId },
		runId: runId ?? null,
		capturedAt,
		collection: { reportedTotal, pagesFetched, pageSize, configSource, invalidCount, duplicateCount },
		items,
	};
}

module.exports = { normalizeItem, normalizeItems, dedupeItems, buildPayload, COMPETITOR, BRAND_NAME, SOURCE };
