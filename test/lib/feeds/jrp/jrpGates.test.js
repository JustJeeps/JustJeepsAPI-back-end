const test = require('node:test');
const assert = require('node:assert');

const { shrinkGate, invalidRatioGate, minMatchedGate, quoteParityGate } = require('../../../../lib/feeds/jrp/jrpGates');

test('shrink gate: passes on the first run and above the ratio, fails below it', () => {
	assert.strictEqual(shrinkGate({ rowsRead: 10, lastRowCount: null, minRatio: 0.7 }), null);
	assert.strictEqual(shrinkGate({ rowsRead: 70, lastRowCount: 100, minRatio: 0.7 }), null);
	assert.match(shrinkGate({ rowsRead: 69, lastRowCount: 100, minRatio: 0.7 }), /69 rows.*100.*minimum 70/);
});

test('invalid ratio gate: fails on an empty feed and above the ratio', () => {
	assert.match(invalidRatioGate({ rowsRead: 0, invalidCount: 0, maxRatio: 0.02 }), /no data rows/);
	assert.strictEqual(invalidRatioGate({ rowsRead: 100, invalidCount: 2, maxRatio: 0.02 }), null);
	assert.match(invalidRatioGate({ rowsRead: 100, invalidCount: 3, maxRatio: 0.02 }), /3 of 100.*3\.00%.*2\.00%/);
});

test('min matched gate: names the count and the threshold', () => {
	assert.strictEqual(minMatchedGate({ matched: 1500, minMatched: 1500 }), null);
	assert.match(minMatchedGate({ matched: 1499, minMatched: 1500 }), /1499 matched.*threshold 1500/);
});

test('quote parity gate: an odd number of quotes on any line names the first one', () => {
	assert.strictEqual(quoteParityGate({ lines: 100, oddQuoteLines: 0, firstOddQuoteLine: null }), null);
	assert.match(quoteParityGate({ lines: 100, oddQuoteLines: 2, firstOddQuoteLine: 7 }), /2 line\(s\).*odd number of quotes.*line 7.*Aborted before any write/);
});
