// One Grandwest price list row (keys = the file header) into a typed row, or
// the reason it is invalid. Pure: no I/O, no config reads.
//
// Item is always "<LineCode>-<part number>". ListPrice is only a sanity check
// on the cost; it, UPC and Desciption are not stored: VendorProduct has no
// column for them and matching never uses UPC (153 UPCs are shared across
// brands in the 2026-11-10 file).

const NUMBER_TEXT = /^\d+(\.\d+)?$/;

const INVALID_REASONS = Object.freeze([
	'missing-item',
	'missing-line-code',
	'item-prefix-mismatch',
	'bad-cost',
	'cost-above-list',
	'bad-quantity',
]);

const text = (value) => String(value ?? '').trim();

function parseNumber(value) {
	const s = text(value);
	return NUMBER_TEXT.test(s) ? Number(s) : null;
}

// Grandwest leaves the cell blank when it has none (0 never appears), and a
// few kit items come in fractions (6.83333): only whole units can ship.
function parseQuantity(value) {
	if (text(value) === '') return 0;
	const n = parseNumber(value);
	return n === null ? null : Math.floor(n);
}

const invalid = (reason) => ({ ok: false, reason });

function partOf(item, lineCode) {
	const prefix = `${lineCode}-`;
	if (!item.toUpperCase().startsWith(prefix)) return null;
	return item.slice(prefix.length).trim() || null;
}

function parseRow(raw) {
	const item = text(raw.Item);
	const lineCode = text(raw.LineCode).toUpperCase();
	if (!item) return invalid('missing-item');
	if (!lineCode) return invalid('missing-line-code');

	const part = partOf(item, lineCode);
	if (!part) return invalid('item-prefix-mismatch');

	const cost = parseNumber(raw.UnitPrice);
	if (cost === null || cost <= 0) return invalid('bad-cost');

	// A dealer cost above the list price is a broken row, never a real price:
	// every WAR row of the 2026-11-10 file is 6x the other vendors' cost. A
	// blank or zero list price says nothing either way.
	const list = parseNumber(raw.ListPrice);
	if (list !== null && list > 0 && cost > list) return invalid('cost-above-list');

	const stock = parseQuantity(raw.Quantity);
	if (stock === null) return invalid('bad-quantity');

	return { ok: true, row: { item, lineCode, part, cost, stock, stockText: String(stock) } };
}

module.exports = { parseRow, INVALID_REASONS };
