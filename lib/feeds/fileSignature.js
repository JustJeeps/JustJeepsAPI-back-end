// Column signature of a vendor file. PURE: no I/O, so the same rules can run
// in the browser (the Imports panel) and on the server (the authority).
//
// A feed file is identified by its header, the exact ordered list of column
// names, never by the name the file arrived with. Vendors export "gold kit
// 10.13.26.xlsx" and people used to rename it to the canonical name by hand,
// which is how a kit file ended up sent as the gold sheet. The order matters:
// several seeds read columns by position (quadratec-excel.js, omix-excel.js,
// quad-inventory-api.js), so a reordered header is a different file and is
// rejected, not imported.
//
// Headers are not always on the first row (KeyParts on row 7, WARN on row 4
// with a leading empty cell, empty cells in the middle and newlines inside the
// names), so the first rows are scanned and the cells are normalized before
// comparing.

const DEFAULT_SCAN_ROWS = 20;

// One cell: text, trimmed, every whitespace run (spaces, tabs, newlines)
// collapsed to a single space. Case is kept: "Item" and "ITEM" are different
// columns to the seeds, so they are different here too.
const normalizeCell = (value) => (value === null || value === undefined ? '' : String(value))
	.replace(/\s+/g, ' ')
	.trim();

// One row: normalized cells with the leading and trailing empty cells dropped.
// Empty cells in the MIDDLE stay, they are part of the layout (WARN has two).
function normalizeHeader(cells) {
	const normalized = (Array.isArray(cells) ? cells : []).map(normalizeCell);
	let start = 0;
	let end = normalized.length;
	while (start < end && normalized[start] === '') start += 1;
	while (end > start && normalized[end - 1] === '') end -= 1;
	return normalized.slice(start, end);
}

const sameHeader = (a, b) => a.length === b.length && a.every((cell, index) => cell === b[index]);

// Index of the first row (within the first scanRows) whose normalized header
// equals the signature exactly and in order; -1 when none does.
function findHeaderRow(rows, signature, { scanRows = DEFAULT_SCAN_ROWS } = {}) {
	const expected = normalizeHeader(signature);
	if (expected.length === 0) return -1;
	const limit = Math.min(Array.isArray(rows) ? rows.length : 0, scanRows);
	for (let index = 0; index < limit; index += 1) {
		if (sameHeader(normalizeHeader(rows[index]), expected)) return index;
	}
	return -1;
}

// Which of the candidates ({ feed, fileName, label, signature, sheet }) does
// this file match? Returns { matches, ambiguous }.
//
// Two files of the same vendor can share a header (Keystone's Inventory.csv
// and SpecialOrder.csv are the same layout with different contents). The
// signature still decides the feed; among the files that share it, the name
// the file arrived with breaks the tie when it equals one of the canonical
// names (case-insensitive). If that does not settle it, the result is
// ambiguous and the caller has to ask.
//
// rowsForSheet: optional, (sheetName) => rows, for candidates that name a
// sheet; without it every candidate is checked against `rows`.
function classify(rows, candidates, { originalName = '', scanRows = DEFAULT_SCAN_ROWS, rowsForSheet = null } = {}) {
	const rowsFor = (candidate) => (candidate.sheet && rowsForSheet ? rowsForSheet(candidate.sheet) || rows : rows);
	const matches = (candidates || []).filter((candidate) => findHeaderRow(rowsFor(candidate), candidate.signature, { scanRows }) >= 0);
	if (matches.length <= 1) return { matches, ambiguous: false };

	const wanted = normalizeCell(originalName).toLowerCase();
	const byName = wanted ? matches.filter((candidate) => candidate.fileName.toLowerCase() === wanted) : [];
	if (byName.length === 1) return { matches: byName, ambiguous: false };
	return { matches, ambiguous: true };
}

// For the error message: which expected columns are missing and which found
// columns are extra, measured on the scanned row that overlaps the signature
// the most (the header row of a wrong file, not a data row). A reordered
// header has nothing missing and nothing extra: the order alone is the
// difference, and the caller says so.
function diffSignature(rows, expected, { scanRows = DEFAULT_SCAN_ROWS } = {}) {
	const wanted = normalizeHeader(expected);
	const wantedSet = new Set(wanted.filter(Boolean));
	let best = { overlap: -1, foundRowIndex: -1, found: [] };
	const limit = Math.min(Array.isArray(rows) ? rows.length : 0, scanRows);
	for (let index = 0; index < limit; index += 1) {
		const found = normalizeHeader(rows[index]);
		const overlap = found.filter((cell) => cell && wantedSet.has(cell)).length;
		if (overlap > best.overlap) best = { overlap, foundRowIndex: index, found };
	}
	const foundSet = new Set(best.found.filter(Boolean));
	return {
		missing: wanted.filter((cell) => cell && !foundSet.has(cell)),
		extra: best.found.filter((cell) => cell && !wantedSet.has(cell)),
		foundRowIndex: best.foundRowIndex,
	};
}

module.exports = {
	DEFAULT_SCAN_ROWS,
	normalizeCell,
	normalizeHeader,
	findHeaderRow,
	classify,
	diffSignature,
};
