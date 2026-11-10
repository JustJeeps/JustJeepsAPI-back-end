// Apply gates of the Grandwest ingest. Each returns null when the run may go
// on, or the reason it must fail. All of them run before any write. The
// shrink and invalid ratio gates are the JRP ones; the merged rows and min
// matched gates are Grandwest's.

const { shrinkGate, invalidRatioGate } = require('../jrp/jrpGates');

// Grandwest descriptions may break across two lines inside quotes (52 in the
// 2026-11-10 file), so the per line quote parity check used for Keystone and
// JRP would refuse every healthy file. What matters is the damage a broken
// quote does: the parser swallows the rows after it and the last swallowed
// row's price lands on the Item that opened the quote. readFeed flags those
// rows; one is enough to stop the run.
function mergedRowsGate({ merged }) {
	if (merged.length === 0) return null;
	const first = merged[0].item || '(no item)';
	return `${merged.length} row(s) swallowed other rows (first: ${first}): a quote in the file is broken, prices could land on the wrong Item. Aborted before any write.`;
}

function minMatchedGate({ matched, minMatched }) {
	if (matched >= minMatched) return null;
	return `Too few matches: ${matched} matched, threshold ${minMatched} (GRANDWEST_MIN_MATCHED). Aborted before any write.`;
}

module.exports = { shrinkGate, invalidRatioGate, mergedRowsGate, minMatchedGate };
