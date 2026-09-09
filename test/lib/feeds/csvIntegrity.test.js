const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkCsvQuoteParity } = require('../../../lib/feeds/csvIntegrity');

function tmpFile(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvint-'));
	const file = path.join(dir, 'feed.csv');
	fs.writeFileSync(file, content);
	return file;
}

test('a well-formed file reports its line count and no odd-quote lines', async () => {
	const file = tmpFile('VCPN,Desc\r\n"A1","COVER, FIT"\r\n"B2","CAR ""COVER"""\r\n');

	const report = await checkCsvQuoteParity(file);

	assert.strictEqual(report.lines, 3);
	assert.strictEqual(report.oddQuoteLines, 0);
	assert.strictEqual(report.firstOddQuoteLine, null);
});

test('a line with an unbalanced quote is reported by number', async () => {
	// Line 3 is the 2026-09-09 shape: a record stitched to the tail of another
	// one by a bad byte resume, leaving 23 quotes on one line.
	const file = tmpFile('VCPN,Desc\n"A1","ok"\n"B2","CUSTOM FIT",9.0IN",759.18\n"C3","ok"\n');

	const report = await checkCsvQuoteParity(file);

	assert.strictEqual(report.lines, 4);
	assert.strictEqual(report.oddQuoteLines, 1);
	assert.strictEqual(report.firstOddQuoteLine, 3);
});

test('parity is tracked across read chunks', async () => {
	const file = tmpFile('VCPN,Desc\n"A1","ok"\n"B2","bad\n"C3","ok"\n');

	const report = await checkCsvQuoteParity(file, { highWaterMark: 4 });

	assert.strictEqual(report.oddQuoteLines, 1, 'parity is per line, so only the broken one counts');
	assert.strictEqual(report.firstOddQuoteLine, 3);
});
