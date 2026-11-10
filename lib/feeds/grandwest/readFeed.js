// Streams the Grandwest price list through parseRow. The file is about 40k
// rows (3.5 MB), so the parsed rows are kept in memory: the gates and the
// matching need all of them before anything is written.

const { streamCsvBatched } = require('../../ingest/streamCsv');
const { parseRow } = require('./parseRow');
const { EXPECTED_COLUMNS } = require('../../../config/grandwest');

const READ_BATCH = 5000;

// Spaces inside the quotes of a header cell pass the upload signature check
// (which trims them) but would leave every row without an Item.
const normalizeHeader = ({ header }) => header.trim();

const text = (value) => String(value ?? '').trim();

const COLUMN_COUNT = EXPECTED_COLUMNS.length;
// A whole Grandwest record ("BDS-001401,BDS,...") inside a field means a
// broken quote made the parser swallow the rows after it, and the swallowed
// row's price would land on this Item. A healthy two-line description never
// carries one (0 of 52 in the 2026-11-10 file). Extra columns (_7, _8...) are
// the other trace of the same damage.
const RECORD_INSIDE = /\n\s*[^\n,"]+-[^\n,]*,[A-Za-z0-9]{2,4},/;

function isMerged(raw) {
	return Object.keys(raw).length > COLUMN_COUNT || Object.values(raw).some((value) => RECORD_INSIDE.test(String(value)));
}

async function readFeed(filePath, { streamCsv = streamCsvBatched } = {}) {
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
	const { rowsRead } = await streamCsv(filePath, { batchSize: READ_BATCH, transform, mapHeaders: normalizeHeader }, onBatch);
	return { rowsRead, rows, invalid, merged };
}

module.exports = { readFeed };
