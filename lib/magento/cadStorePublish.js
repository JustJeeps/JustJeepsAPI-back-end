// Pure rules of the CAD store CSV publish
// (pricing_update/cad_store/update-prices-from-csv-cad-store.js). The script
// keeps the CLI and the HTTP; what can be decided without the network lives
// here so it can be tested.

// Two prices are the same when they agree to the cent.
const PRICE_EPSILON = 0.005;

const priceKey = (row) => `${row.sku}\u0000${row.store_id}`;

/**
 * The CSV may list a SKU twice. Sending both puts two prices for the same
 * product in one batch; the first one wins, as it already does for attributes.
 * @param {Array<{sku: string, price: number, store_id: number}>} rows
 */
function dedupePriceRows(rows) {
	const seen = new Set();
	const kept = [];
	const duplicates = [];
	for (const row of rows) {
		const key = priceKey(row);
		if (seen.has(key)) {
			duplicates.push(row);
			continue;
		}
		seen.add(key);
		kept.push(row);
	}
	return { rows: kept, duplicates };
}

/**
 * Splits the rows into the ones the store already has, the ones to send and
 * the ones whose SKU the store does not know.
 * A row with no known current price is sent: assuming "equal" would silently
 * skip a real change. A SKU is only called unknown when the lookup was
 * complete (lookupComplete), because then its absence means Magento does not
 * have the product, and sending it could only be rejected.
 * @param {Array<{sku: string, price: number, store_id: number}>} rows
 * @param {Map<string, Map<number, number>>} currentBySku sku -> store_id -> price
 * @param {{lookupComplete?: boolean}} [options]
 */
function diffPriceRows(rows, currentBySku, { lookupComplete = false } = {}) {
	const changed = [];
	const unchanged = [];
	const unknown = [];
	for (const row of rows) {
		if (lookupComplete && !currentBySku.has(row.sku)) {
			unknown.push(row);
			continue;
		}
		const current = currentBySku.get(row.sku)?.get(row.store_id);
		const isSame = Number.isFinite(current) && Math.abs(current - row.price) < PRICE_EPSILON;
		(isSame ? unchanged : changed).push(row);
	}
	return { changed, unchanged, unknown };
}

/**
 * POST /products/base-prices answers HTTP 200 even when it rejects rows: the
 * body is the list of row errors (empty when everything was accepted). Each
 * error names its SKU in `parameters`.
 * @param {unknown} responseData
 * @param {Array<{sku: string}>} batch
 * @returns {Array<{sku: string, error: string}>}
 */
function collectBasePriceErrors(responseData, batch) {
	if (!Array.isArray(responseData)) return [];
	const batchSkus = new Set(batch.map((row) => row.sku));

	return responseData.map((entry) => {
		const parameters = Array.isArray(entry?.parameters) ? entry.parameters.map(String) : [];
		const message = String(entry?.message || 'base-prices rejected the row');
		const sku = parameters.find((value) => batchSkus.has(value)) || '';
		const error = parameters.length ? `${message} [${parameters.join(', ')}]` : message;
		return { sku, error };
	});
}

/**
 * A SKU the store does not know is skipped on purpose and does not fail the
 * run; any other failed row does, so the panel never shows "success" over it.
 * @param {Array<{skipped?: boolean}>} failedRows
 */
function publishExitCode(failedRows) {
	return failedRows.some((row) => !row.skipped) ? 1 : 0;
}

module.exports = { dedupePriceRows, diffPriceRows, collectBasePriceErrors, publishExitCode };
