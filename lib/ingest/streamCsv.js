const fs = require("fs");
const csv = require("csv-parser");

// Windowed CSV streaming with backpressure: pauses the stream while onBatch
// (normally an insert into staging) runs. Memory is O(batchSize), never
// O(file size). `transform` returns null to drop the row (a cheap filter still
// inside the stream, the pattern from the keystone OOM fix).

async function streamCsvBatched(absPath, { batchSize = 10000, transform } = {}, onBatch) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absPath).pipe(csv());
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
      if (!failed) reject(err);
      else reject(err);
    });
  });
}

module.exports = { streamCsvBatched };
