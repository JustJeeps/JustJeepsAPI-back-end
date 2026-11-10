// Grandwest sometimes lists one Item twice with different prices (80 Items in
// the 2026-11-10 file, e.g. TYG-TG-BC9C8003 at 829 and 779, order flipping
// between files). Picking one would be a guess, so every copy is dropped and
// the Item is listed once for the report (decision of 2026-11-10). Invalid
// rows count as copies too: when one copy has cost 0 and the other 779, the
// 779 is still a guess, so it is dropped as well. Pure.

const DUPLICATE_REASON = 'duplicate-item';

const itemKey = (item) => String(item).toUpperCase().replace(/\s+/g, ' ').trim();

function dropRepeatedItems(rows, invalid = []) {
	const copies = new Map();
	const seen = [...rows, ...invalid].filter((row) => String(row.item ?? '').trim());
	for (const row of seen) copies.set(itemKey(row.item), (copies.get(itemKey(row.item)) || 0) + 1);

	const kept = rows.filter((row) => copies.get(itemKey(row.item)) === 1);
	const reported = new Set();
	const duplicates = rows
		.filter((row) => copies.get(itemKey(row.item)) > 1)
		.filter((row) => {
			const key = itemKey(row.item);
			if (reported.has(key)) return false;
			reported.add(key);
			return true;
		})
		.map((row) => ({ item: row.item, lineCode: row.lineCode, reason: DUPLICATE_REASON, copies: copies.get(itemKey(row.item)) }));
	return { rows: kept, duplicates };
}

module.exports = { dropRepeatedItems, itemKey, DUPLICATE_REASON };
