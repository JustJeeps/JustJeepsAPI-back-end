// CSV for the Niagara Jeeps review reports (DD-021). Same formula guard as the
// JRP report (lib/feeds/jrp/unmatchedReport.js): a cell a spreadsheet would
// run as a formula gets a leading quote. Pure.

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
	if (value === null || value === undefined) return '';
	let text = String(value);
	if (FORMULA_START.test(text)) text = `'${text}`;
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
	const lines = [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))];
	return `${lines.join('\n')}\n`;
}

module.exports = { toCsv };
