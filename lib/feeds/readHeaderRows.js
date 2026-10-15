// Reads the first rows of a feed file (CSV or Excel) as arrays of cells, the
// input of lib/feeds/fileSignature.js. Takes a buffer, so the caller decides
// where the bytes come from (disk, a ranged GET on the bucket, a browser File).
//
// Only the top of the file is parsed: sheetRows caps the Excel parse and a CSV
// is cut at CSV_HEAD_BYTES before parsing (SpecialOrder.csv is 460MB; the
// header is in the first line). A cut CSV can end mid-line, so the last line
// is dropped when the buffer was truncated.

const XLSX = require('xlsx');
const { DEFAULT_SCAN_ROWS } = require('./fileSignature');

const CSV_HEAD_BYTES = 64 * 1024;

const isCsvName = (name) => /\.csv$/i.test(String(name || ''));

const sheetNotFound = (sheet, workbook) => {
	const error = new Error(`sheet "${sheet}" not found (sheets: ${workbook.SheetNames.join(', ') || 'none'})`);
	error.code = 'FEED_SHEET_NOT_FOUND';
	error.sheetNames = workbook.SheetNames;
	return error;
};

const rowsOfSheet = (sheet) => XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

// Excel: the named sheet when asked for one (a typed error when it is not
// there, the seed would fail on it too), otherwise the first sheet.
function readExcelHeaderRows(buffer, { sheet = null, scanRows = DEFAULT_SCAN_ROWS } = {}) {
	const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: scanRows, cellDates: false });
	const name = sheet || workbook.SheetNames[0];
	const target = name ? workbook.Sheets[name] : null;
	if (!target) {
		if (sheet) throw sheetNotFound(sheet, workbook);
		return [];
	}
	return rowsOfSheet(target).slice(0, scanRows);
}

// CSV: only the head is parsed. truncated says whether the buffer is a cut of
// a bigger file, in which case the last (possibly partial) line is dropped.
function readCsvHeaderRows(buffer, { scanRows = DEFAULT_SCAN_ROWS, truncated = false } = {}) {
	let text = buffer.slice(0, CSV_HEAD_BYTES).toString('utf8');
	if (truncated || buffer.length > CSV_HEAD_BYTES) {
		const lastBreak = text.lastIndexOf('\n');
		text = lastBreak >= 0 ? text.slice(0, lastBreak) : '';
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (text.trim() === '') return [];
	const workbook = XLSX.read(text, { type: 'string', sheetRows: scanRows, raw: true });
	const first = workbook.Sheets[workbook.SheetNames[0]];
	return first ? rowsOfSheet(first).slice(0, scanRows) : [];
}

// fileName picks the parser by extension (.csv, otherwise Excel).
function readHeaderRows(buffer, { fileName = '', sheet = null, scanRows = DEFAULT_SCAN_ROWS, truncated = false } = {}) {
	return isCsvName(fileName)
		? readCsvHeaderRows(buffer, { scanRows, truncated })
		: readExcelHeaderRows(buffer, { sheet, scanRows });
}

module.exports = { readHeaderRows, readExcelHeaderRows, readCsvHeaderRows, isCsvName, CSV_HEAD_BYTES };
