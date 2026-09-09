const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { streamCsvBatched } = require('../../../lib/ingest/streamCsv');

function tmpFile(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamcsv-'));
	const file = path.join(dir, 'feed.csv');
	fs.writeFileSync(file, content);
	return file;
}

test('rows are delivered in batches with the counts', async () => {
	const file = tmpFile('VCPN,Cost\nA1,1\nB2,2\nC3,3\n');
	const batches = [];

	const result = await streamCsvBatched(file, { batchSize: 2 }, async (batch) => batches.push(batch.map((r) => r.VCPN)));

	assert.deepStrictEqual(batches, [['A1', 'B2'], ['C3']]);
	assert.deepStrictEqual(result, { rowsRead: 3, rowsKept: 3, batches: 2 });
});

test('a row that never closes its quote fails fast instead of buffering the rest of the file', async () => {
	// The csv-parser default is no limit: after an unbalanced quote it keeps
	// the remainder of the file in memory until the process dies (2026-09-09).
	const tail = Array.from({ length: 500 }, (_, i) => `"Z${i}","ok",${i}\n`).join('');
	const file = tmpFile(`VCPN,Desc,Cost\n"A1","ok",1\n"B2","bad,2\n${tail}`);

	await assert.rejects(
		streamCsvBatched(file, { batchSize: 100, maxRowBytes: 1024 }, async () => {}),
		/Row exceeds the maximum size/
	);
});
