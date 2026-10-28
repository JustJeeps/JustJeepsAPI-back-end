// Apply gates of the JRP ingest. Each returns null when the run may go on, or
// the reason it must fail. All of them run before any write.

const percent = (ratio) => `${(ratio * 100).toFixed(2)}%`;

function shrinkGate({ rowsRead, lastRowCount, minRatio }) {
	if (!Number.isFinite(lastRowCount) || lastRowCount <= 0) return null;
	const minimum = Math.ceil(lastRowCount * minRatio);
	if (rowsRead >= minimum) return null;
	return `Feed shrank: ${rowsRead} rows parsed vs ${lastRowCount} in the last successful run (minimum ${minimum}). Truncated file? Aborted before any write.`;
}

function invalidRatioGate({ rowsRead, invalidCount, maxRatio }) {
	if (rowsRead === 0) return 'Feed has no data rows. Aborted before any write.';
	const ratio = invalidCount / rowsRead;
	if (ratio <= maxRatio) return null;
	return `Too many invalid rows: ${invalidCount} of ${rowsRead} (${percent(ratio)}, maximum ${percent(maxRatio)}). Aborted before any write.`;
}

// The fetch runs the same check; the panel and CLI uploads do not, and
// csv-parser silently merges the rows after an unbalanced quote.
function quoteParityGate({ oddQuoteLines, firstOddQuoteLine }) {
	if (!oddQuoteLines) return null;
	return `File has ${oddQuoteLines} line(s) with an odd number of quotes (first at line ${firstOddQuoteLine}). Corrupted upload? Aborted before any write.`;
}

function minMatchedGate({ matched, minMatched }) {
	if (matched >= minMatched) return null;
	return `Too few matches: ${matched} matched, threshold ${minMatched} (JRP_MIN_MATCHED). Aborted before any write.`;
}

module.exports = { shrinkGate, invalidRatioGate, quoteParityGate, minMatchedGate };
