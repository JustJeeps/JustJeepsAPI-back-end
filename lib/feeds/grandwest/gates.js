// Apply gates of the Grandwest ingest. Each returns null when the run may go
// on, or the reason it must fail. All of them run before any write. The
// shrink and invalid ratio gates are the JRP ones; the quote and min matched
// gates differ.

const { shrinkGate, invalidRatioGate } = require('../jrp/jrpGates');

// Grandwest descriptions may break across two lines inside quotes (52 in the
// 2026-11-10 file), so the per line parity check used for Keystone and JRP
// would refuse every healthy file. What still betrays a damaged upload is a
// quote that never closes: then the total number of odd lines is odd. A
// stray quote that does close later merges rows, which the row size limit of
// streamCsv and the invalid ratio gate catch.
function quoteBalanceGate({ oddQuoteLines, firstOddQuoteLine }) {
	if (oddQuoteLines % 2 === 0) return null;
	return `File has an unclosed quote (first odd line at line ${firstOddQuoteLine}). Corrupted upload? Aborted before any write.`;
}

function minMatchedGate({ matched, minMatched }) {
	if (matched >= minMatched) return null;
	return `Too few matches: ${matched} matched, threshold ${minMatched} (GRANDWEST_MIN_MATCHED). Aborted before any write.`;
}

module.exports = { shrinkGate, invalidRatioGate, quoteBalanceGate, minMatchedGate };
