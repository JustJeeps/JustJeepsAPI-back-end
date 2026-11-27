// Pure rules of the vendor attribute sync
// (prisma/seeds/seed-individual/seed-attribute-magento.js). The script used to
// PUT every product on every run; each PUT is a full product save in Magento.
// These rules decide, without the network, which products really changed.

const { readCustomAttribute } = require('./cadStorePublish');

const ATTRIBUTE_CODES = Object.freeze(['cost_usd', 'inventory_vendor']);

// Two numbers are the same when they agree to the cent.
const NUMBER_EPSILON = 0.005;

const skuKey = (sku) => String(sku).trim().toLowerCase();

/**
 * The inventory text the store shows. A missing number falls back to the
 * vendor's inventory string, then to 'NO INFO'. Rough Country reports 0 for
 * items it ships on lead time, so its string wins over a numeric zero.
 * @param {{vendor_inventory?: number|null, vendor_inventory_string?: string|null, vendor_name?: string}} product
 * @returns {string}
 */
function resolveInventoryValue(product) {
	const inventory = product.vendor_inventory;
	if (inventory === null || inventory === undefined) {
		return String(product.vendor_inventory_string || 'NO INFO');
	}
	const isRoughCountry =
		typeof product.vendor_name === 'string' && product.vendor_name.toLowerCase().includes('rough country');
	if (isRoughCountry && Number(inventory) === 0 && product.vendor_inventory_string) {
		return String(product.vendor_inventory_string);
	}
	return String(inventory);
}

/**
 * The two attribute values the script writes for one vendor product.
 * @param {{vendor_cost: number}} product
 * @param {number} usdToCadRate
 * @returns {{cost_usd: string, inventory_vendor: string}}
 */
function buildAttributeValues(product, usdToCadRate) {
	return {
		cost_usd: (parseFloat(product.vendor_cost) / usdToCadRate).toFixed(2),
		inventory_vendor: resolveInventoryValue(product),
	};
}

const asNumber = (value) => {
	const text = String(value ?? '').trim();
	return text === '' ? NaN : Number(text);
};

/**
 * Magento may answer '12.3' for '12.30', so numbers are compared as numbers.
 * A value the store does not have is never equal: it has to be sent.
 * @param {string} wanted
 * @param {unknown} current
 * @returns {boolean}
 */
function sameAttributeValue(wanted, current) {
	if (current === undefined || current === null || String(current).trim() === '') return false;
	const a = asNumber(wanted);
	const b = asNumber(current);
	if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < NUMBER_EPSILON;
	return String(wanted).trim() === String(current).trim();
}

/**
 * Splits the rows into the ones the store already has and the ones to send.
 * A SKU the lookup did not return is sent anyway (notFound reports it): an
 * incomplete lookup must never turn a real change into a skip.
 * @param {Array<{sku: string, values: Record<string, string>}>} rows
 * @param {Map<string, Record<string, string>>} currentBySku lower-case sku -> values
 */
function diffAttributeRows(rows, currentBySku) {
	const changed = [];
	const unchanged = [];
	const notFound = [];
	for (const row of rows) {
		const current = currentBySku.get(skuKey(row.sku));
		if (!current) {
			notFound.push(row);
			changed.push(row);
			continue;
		}
		const isSame = ATTRIBUTE_CODES.every((code) => sameAttributeValue(row.values[code], current[code]));
		(isSame ? unchanged : changed).push(row);
	}
	return { changed, unchanged, notFound };
}

/**
 * Query params of GET /products that read the two attributes of one batch.
 * @param {string[]} skus
 * @returns {Record<string, string|number>}
 */
function buildSkuLookupQuery(skus) {
	return {
		'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
		'searchCriteria[filter_groups][0][filters][0][value]': skus.join(','),
		'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in',
		'searchCriteria[pageSize]': skus.length,
		fields: `items[sku,custom_attributes[${ATTRIBUTE_CODES.join(',')}]]`,
	};
}

/**
 * Indexes the GET /products items by lower-case SKU.
 * @param {Array<{sku?: string, custom_attributes?: unknown}>} items
 * @returns {Map<string, Record<string, string>>}
 */
function indexCurrentValues(items) {
	const bySku = new Map();
	for (const item of Array.isArray(items) ? items : []) {
		if (!item?.sku) continue;
		const values = Object.fromEntries(ATTRIBUTE_CODES.map((code) => [code, readCustomAttribute(item, code)]));
		bySku.set(skuKey(item.sku), values);
	}
	return bySku;
}

module.exports = {
	ATTRIBUTE_CODES,
	buildAttributeValues,
	sameAttributeValue,
	diffAttributeRows,
	buildSkuLookupQuery,
	indexCurrentValues,
};
