// Fail-loud checks (DD-018 section 7). Hard canaries run before any write; a
// partial or foreign collection must abort the run, because a silent partial
// write poisons the pricing table far worse than a missing run does.

const DEFAULT_THRESHOLDS = Object.freeze({
	minCollectRatio: 0.9,
	minItems: 5000,
	maxBrandImpurityRatio: 0.005,
	maxInvalidRatio: 0.02,
	maxDuplicateRatio: 0.01,
	brandName: 'Rough Country',
	minMatched: 500,
	matchDropRatio: 0.8,
});

function withDefaults(thresholds) {
	return { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
}

function checkCollection({ items = [], reportedTotal = 0, invalidCount = 0, duplicateCount = 0, thresholds } = {}) {
	const t = withDefaults(thresholds);
	const failures = [];
	const collected = items.length;
	const rawCount = collected + invalidCount + duplicateCount;

	if (reportedTotal > 0 && collected < Math.ceil(reportedTotal * t.minCollectRatio)) {
		failures.push({
			code: 'TOTAL_MISMATCH',
			message: `collected ${collected} of ${reportedTotal} reported (min ratio ${t.minCollectRatio})`,
			detail: { collected, reportedTotal, minCollectRatio: t.minCollectRatio },
		});
	}
	if (collected < t.minItems) {
		failures.push({ code: 'BELOW_MIN_ITEMS', message: `collected ${collected}, minimum ${t.minItems}`, detail: { collected, minItems: t.minItems } });
	}

	const foreign = items.filter((i) => i.brandName !== t.brandName);
	if (collected > 0 && foreign.length / collected > t.maxBrandImpurityRatio) {
		failures.push({
			code: 'BRAND_IMPURE',
			message: `${foreign.length} of ${collected} items are not ${t.brandName}`,
			detail: { impure: foreign.length, sample: foreign.slice(0, 5).map((i) => `${i.competitorSku} (${i.brandName})`) },
		});
	}
	if (rawCount > 0 && invalidCount / rawCount > t.maxInvalidRatio) {
		failures.push({ code: 'PRICE_INVALID_RATIO', message: `${invalidCount} of ${rawCount} items had no usable price or part number`, detail: { invalidCount, rawCount } });
	}
	if (rawCount > 0 && duplicateCount / rawCount > t.maxDuplicateRatio) {
		failures.push({ code: 'DUPLICATE_STOCKIDS', message: `${duplicateCount} of ${rawCount} items were duplicates`, detail: { duplicateCount, rawCount } });
	}

	return {
		ok: failures.length === 0,
		failures,
		stats: { collected, reportedTotal, invalidCount, duplicateCount, impure: foreign.length },
	};
}

// Soft floor: gates only the stale delete. When it fails the prices still
// update; we just refuse to remove rows on the strength of a thin run.
function checkStaleFloor({ matched = 0, previousMatched = null, thresholds } = {}) {
	const t = withDefaults(thresholds);
	if (matched < t.minMatched) return { ok: false, reason: `matched ${matched} is below minMatched ${t.minMatched}` };
	if (previousMatched !== null && previousMatched !== undefined && matched < previousMatched * t.matchDropRatio) {
		return { ok: false, reason: `matched ${matched} dropped below ${t.matchDropRatio} of the previous run (${previousMatched})` };
	}
	return { ok: true, reason: null };
}

module.exports = { DEFAULT_THRESHOLDS, checkCollection, checkStaleFloor };
