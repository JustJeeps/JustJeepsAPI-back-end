const test = require('node:test');
const assert = require('node:assert');

const gates = require('../../../../lib/feeds/grandwest/gates');

test('descriptions that span two lines pass: every quote that opens also closes', () => {
	assert.strictEqual(gates.quoteBalanceGate({ oddQuoteLines: 104, firstOddQuoteLine: 793 }), null);
	assert.strictEqual(gates.quoteBalanceGate({ oddQuoteLines: 0, firstOddQuoteLine: null }), null);
});

test('a quote left open fails before any write', () => {
	assert.match(gates.quoteBalanceGate({ oddQuoteLines: 3, firstOddQuoteLine: 12 }), /quote.*line 12.*Aborted before any write/);
});

test('too few matches fails and names the env override', () => {
	assert.strictEqual(gates.minMatchedGate({ matched: 600, minMatched: 500 }), null);
	assert.match(gates.minMatchedGate({ matched: 12, minMatched: 500 }), /12 matched.*500.*GRANDWEST_MIN_MATCHED/);
});

test('the shrink and invalid ratio gates are the shared ones', () => {
	assert.match(gates.shrinkGate({ rowsRead: 10, lastRowCount: 40000, minRatio: 0.7 }), /Feed shrank/);
	assert.strictEqual(gates.shrinkGate({ rowsRead: 40000, lastRowCount: null, minRatio: 0.7 }), null);
	assert.match(gates.invalidRatioGate({ rowsRead: 100, invalidCount: 5, maxRatio: 0.02 }), /Too many invalid rows/);
});
