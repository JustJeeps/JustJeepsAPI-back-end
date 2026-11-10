// Streams the Grandwest price list through parseRow. The file is about 40k
// rows (3.5 MB), so the parsed rows are kept in memory: the gates and the
// matching need all of them before anything is written.

const { streamCsvBatched } = require('../../ingest/streamCsv');
const { parseRow } = require('./parseRow');
const { EXPECTED_COLUMNS } = require('../../../config/grandwest');

const READ_BATCH = 5000;

// Spaces inside the quotes of a header cell pass the upload signature check
// (which trims them) but would leave every row without an Item. An empty cell
// (a trailing comma) is dropped, or every row would count an extra column.
const normalizeHeader = ({ header }) => header.trim() || null;

const text = (value) => String(value ?? '').trim();

const COLUMN_COUNT = EXPECTED_COLUMNS.length;
// A whole Grandwest record inside a field means a broken quote made the
// parser swallow the rows after it, and the swallowed row's price would land
// on this Item. A record is recognised by its own rule, "CODE-part,CODE,":
// the Item starts with the line code that follows it, whatever its length. A
// healthy two-line description never carries one (0 of 52 in the 2026-11-10
// file). Extra columns (_7, _8...) are the other trace of the same damage.
const RECORD_INSIDE = /\n\s*([^\n,"-]+)-[^\n,]*,\1,/i;

function isMerged(raw) {
	return Object.keys(raw).length > COLUMN_COUNT || Object.values(raw).some((value) => RECORD_INSIDE.test(String(value)));
}

// The upload check accepts a title line above the header or another
// delimiter; parsed, those leave every row without an Item, so the run would
// fail on the invalid ratio for the wrong reason.
function checkHeader(headers) {
	const missing = EXPECTED_COLUMNS.filter((column) => !headers.includes(column));
	if (missing.length === 0) return;
	throw new Error(`Grandwest header not found on line 1 (missing ${missing.join(', ')}): the file needs the header on line 1 and comma delimiters. Aborted before any write.`);
}

async function readFeed(filePath, { streamCsv = streamCsvBatched } = {}) {
	const headers = [];
	const mapHeaders = (args) => {
		const header = normalizeHeader(args);
		if (header) headers.push(header);
		return header;
	};
	const rows = [];
	const invalid = [];
	const merged = [];
	const transform = (raw) => ({ raw, parsed: parseRow(raw) });
	const onBatch = async (batch) => {
		for (const { raw, parsed } of batch) {
			if (isMerged(raw)) merged.push({ item: text(raw.Item), lineCode: text(raw.LineCode).toUpperCase(), reason: 'merged-rows' });
			else if (parsed.ok) rows.push(parsed.row);
			else invalid.push({ item: text(raw.Item), lineCode: text(raw.LineCode).toUpperCase(), reason: parsed.reason });
		}
	};
	const { rowsRead } = await streamCsv(filePath, { batchSize: READ_BATCH, transform, mapHeaders }, onBatch);
	checkHeader(headers);
	return { rowsRead, rows, invalid, merged };
}

module.exports = { readFeed };
