// One JUSJEE.csv row (keys = the feed header) into a typed row, or the reason
// it is invalid. Pure: no I/O, no config reads; the "4+" value comes in.

const STOCK_PLUS_TEXT = '4+';
const STOCK_DIGITS = /^[0-3]$/;
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

const INVALID_REASONS = Object.freeze([
	'missing-brand',
	'missing-jrpsku',
	'missing-oemsku',
	'bad-stock',
	'bad-cost',
	'bad-map',
]);

const text = (value) => String(value ?? '').trim();

function parseNumber(value) {
	const s = text(value);
	return NUMBER_TEXT.test(s) ? Number(s) : null;
}

function parseStock(stockText, stockPlusValue) {
	if (stockText === STOCK_PLUS_TEXT) return stockPlusValue;
	return STOCK_DIGITS.test(stockText) ? Number(stockText) : null;
}

const invalid = (reason) => ({ ok: false, reason });

// MAP is parsed and validated but never written (VendorProduct has no MAP
// column). JRP sends -0.01 when a part has no MAP: such rows are kept with
// map null and counted as map below cost, like a real MAP under COST.
function parseRow(raw, { stockPlusValue }) {
	const brandLabel = text(raw.BRAND);
	const jrpSku = text(raw.JRPSKU);
	const oemSku = text(raw.OEMSKU);
	const stockText = text(raw['IN-STOCK']);
	if (!brandLabel) return invalid('missing-brand');
	if (!jrpSku) return invalid('missing-jrpsku');
	if (!oemSku) return invalid('missing-oemsku');

	const stock = parseStock(stockText, stockPlusValue);
	if (stock === null) return invalid('bad-stock');

	const cost = parseNumber(raw.COST);
	if (cost === null || cost < 0) return invalid('bad-cost');

	const parsedMap = parseNumber(raw.MAP);
	if (parsedMap === null) return invalid('bad-map');
	const map = parsedMap < 0 ? null : parsedMap;

	return {
		ok: true,
		row: {
			brandLabel,
			jrpSku,
			oemSku,
			description: text(raw.DESCRIPTION),
			stock,
			stockText,
			cost,
			map,
			mapBelowCost: map === null || map < cost,
		},
	};
}

module.exports = { parseRow, INVALID_REASONS, STOCK_PLUS_TEXT };
