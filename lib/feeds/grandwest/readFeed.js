// Streams the Grandwest price list through parseRow. The file is about 40k
// rows (3.5 MB), so the parsed rows are kept in memory: the gates and the
// matching need all of them before anything is written.

const { streamCsvBatched } = require('../../ingest/streamCsv');
const { parseRow } = require('./parseRow');

const READ_BATCH = 5000;

// Spaces inside the quotes of a header cell pass the upload signature check
// (which trims them) but would leave every row without an Item.
const normalizeHeader = ({ header }) => header.trim();

const text = (value) => String(value ?? '').trim();

async function readFeed(filePath, { streamCsv = streamCsvBatched } = {}) {
	const rows = [];
	const invalid = [];
	const transform = (raw) => ({ raw, parsed: parseRow(raw) });
	const onBatch = async (batch) => {
		for (const { raw, parsed } of batch) {
			if (parsed.ok) rows.push(parsed.row);
			else invalid.push({ item: text(raw.Item), lineCode: text(raw.LineCode).toUpperCase(), reason: parsed.reason });
		}
	};
	const { rowsRead } = await streamCsv(filePath, { batchSize: READ_BATCH, transform, mapHeaders: normalizeHeader }, onBatch);
	return { rowsRead, rows, invalid };
}

module.exports = { readFeed };
