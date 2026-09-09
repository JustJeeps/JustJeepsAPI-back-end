// Structural check for a CSV that is about to be catalogued as a feed: every
// line must carry an even number of double quotes. A byte resume that
// stitched two records together (2026-09-09, SpecialOrder.csv) leaves one line
// with an odd count, and csv-parser then treats the rest of the file as a
// single quoted field, buffering it in memory until the process dies. The
// file keeps its size and header, so only a full pass catches it.
//
// Assumes the feed has no multi-line quoted fields (true for the Keystone
// files: 2.4M lines, zero odd-quote lines on every healthy batch). Streams
// the file, memory is O(chunk).

const fs = require('fs');

const QUOTE = 0x22;
const NEWLINE = 0x0a;

function checkCsvQuoteParity(filePath, { highWaterMark } = {}) {
	return new Promise((resolve, reject) => {
		let lines = 0;
		let oddQuoteLines = 0;
		let firstOddQuoteLine = null;
		let quotesOnLine = 0;
		let bytesOnLine = 0;

		const closeLine = () => {
			lines += 1;
			if (quotesOnLine % 2 === 1) {
				oddQuoteLines += 1;
				if (firstOddQuoteLine === null) firstOddQuoteLine = lines;
			}
			quotesOnLine = 0;
			bytesOnLine = 0;
		};

		fs.createReadStream(filePath, highWaterMark ? { highWaterMark } : undefined)
			.on('data', (chunk) => {
				for (let i = 0; i < chunk.length; i += 1) {
					const byte = chunk[i];
					if (byte === NEWLINE) {
						closeLine();
					} else {
						bytesOnLine += 1;
						if (byte === QUOTE) quotesOnLine += 1;
					}
				}
			})
			.on('error', reject)
			.on('end', () => {
				if (bytesOnLine > 0) closeLine();
				resolve({ lines, oddQuoteLines, firstOddQuoteLine });
			});
	});
}

module.exports = { checkCsvQuoteParity };
