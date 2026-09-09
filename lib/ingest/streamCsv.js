const fs = require("fs");
const csv = require("csv-parser");

// Windowed CSV streaming with backpressure: pauses the stream while onBatch
// (normally an insert into staging) runs. Memory is O(batchSize), never
// O(file size). `transform` returns null to drop the row (a cheap filter still
// inside the stream, the pattern from the keystone OOM fix).

// csv-parser has no row limit by default: after an unbalanced quote it keeps
// the rest of the file in memory until the process dies (2026-09-09, 368MB).
// A feed row is a few hundred bytes; anything past this is a broken file and
// must fail in seconds with a clear error, not in half an hour with an OOM.
const DEFAULT_MAX_ROW_BYTES = 1024 * 1024;

async function streamCsvBatched(absPath, { batchSize = 10000, transform, maxRowBytes = DEFAULT_MAX_ROW_BYTES } = {}, onBatch) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absPath).pipe(csv({ maxRowBytes }));
    let batch = [];
    let rowsRead = 0;
    let rowsKept = 0;
    let batches = 0;
    let failed = false;

    const flush = async () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      batches++;
      await onBatch(current);
    };

    stream.on("data", (row) => {
      rowsRead++;
      const out = transform ? transform(row) : row;
      if (out === null || out === undefined) return;
      rowsKept++;
      batch.push(out);

      if (batch.length >= batchSize) {
        stream.pause();
        flush()
          .then(() => stream.resume())
          .catch((err) => {
            failed = true;
            stream.destroy(err);
          });
      }
    });

    stream.on("end", () => {
      flush()
        .then(() => resolve({ rowsRead, rowsKept, batches }))
        .catch(reject);
    });

    stream.on("error", (err) => {
      if (!failed) reject(new Error(`${err.message} (${absPath}, after ${rowsRead} rows)`));
      else reject(err);
    });
  });
}

module.exports = { streamCsvBatched, DEFAULT_MAX_ROW_BYTES };
