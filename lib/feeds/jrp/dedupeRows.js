// One feed row per JRPSKU before matching. vendor_sku is the JRPSKU, so a
// repeated JRPSKU would reach the stage twice and DISTINCT ON would pick an
// arbitrary copy. The first copy in feed order wins (deterministic); the
// others are listed for the report and never written. Pure.

const DUPLICATE_REASON = 'duplicate-jrpsku';

const identity = (row) => ({ brandLabel: row.brandLabel, jrpSku: row.jrpSku, oemSku: row.oemSku });

function dedupeByJrpSku(rows) {
	const seen = new Set();
	const rowsOut = [];
	const duplicates = [];
	for (const row of rows) {
		if (seen.has(row.jrpSku)) {
			duplicates.push({ ...identity(row), reason: DUPLICATE_REASON });
			continue;
		}
		seen.add(row.jrpSku);
		rowsOut.push(row);
	}
	return { rows: rowsOut, duplicates };
}

module.exports = { dedupeByJrpSku };
