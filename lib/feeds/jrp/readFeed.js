// Streams JUSJEE.csv through parseRow. The whole feed is about 26k rows (3 MB),
// so the parsed rows are kept in memory: the gates and the matching need all
// of them before anything is written.

const { streamCsvBatched } = require('../../ingest/streamCsv');
const { parseRow } = require('./parseRow');

const READ_BATCH = 5000;

// Spaces inside the quotes of a header cell pass the fetch signature check
// (which trims them) but would leave every row without a BRAND. The BOM is
// handled by streamCsv; spaces outside the quotes are rejected by the fetch.
const normalizeHeader = ({ header }) => header.trim();

async function readFeed(filePath, { stockPlusValue, streamCsv = streamCsvBatched }) {
	const rows = [];
	const invalid = [];
	const transform = (raw) => ({ raw, parsed: parseRow(raw, { stockPlusValue }) });
	const onBatch = async (batch) => {
		for (const { raw, parsed } of batch) {
			if (parsed.ok) rows.push(parsed.row);
			else invalid.push({ jrpSku: String(raw.JRPSKU ?? '').trim(), reason: parsed.reason });
		}
	};
	const { rowsRead } = await streamCsv(filePath, { batchSize: READ_BATCH, transform, mapHeaders: normalizeHeader }, onBatch);
	return { rowsRead, rows, invalid };
}

module.exports = { readFeed };
