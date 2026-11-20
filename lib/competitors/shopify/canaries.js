// Fail-loud checks before any Niagara Jeeps write (DD-021), same idea as the
// TDOT and Lowriders canaries: a run that could not read the site, lost many
// brands, saw broken prices or matched far less than last time must abort,
// because a silent thin write is worse than a missing run. A sample run
// (--brands / --max-pages) skips the size floors and the match drop: it covers
// a few brands or pages on purpose, so a full run is no yardstick for it.
// Pure.

const failure = (code, message, detail) => ({ code, message, detail });

function checkCollection(c, t, { sample = false } = {}) {
	const failures = [];
	if (c.requests > 0 && c.failedRequests / c.requests > t.maxFailedRequestRatio) {
		failures.push(failure('REQUEST_FAILED_RATIO', `${c.failedRequests} of ${c.requests} requests failed (max ratio ${t.maxFailedRequestRatio})`, { requests: c.requests, failedRequests: c.failedRequests }));
	}
	if (c.brandsPlanned > 0 && c.brandsFailed / c.brandsPlanned > t.maxBrandsFailedRatio) {
		failures.push(failure('BRANDS_FAILED_RATIO', `${c.brandsFailed} of ${c.brandsPlanned} brands failed (max ratio ${t.maxBrandsFailedRatio})`, { brandsPlanned: c.brandsPlanned, brandsFailed: c.brandsFailed }));
	}
	if (c.rawVariants > 0 && c.invalidCount / c.rawVariants > t.maxInvalidRatio) {
		failures.push(failure('PRICE_INVALID_RATIO', `${c.invalidCount} of ${c.rawVariants} variants had no usable sku, price or link`, { invalidCount: c.invalidCount, rawVariants: c.rawVariants }));
	}
	if (!sample && c.items < t.minItems) {
		failures.push(failure('BELOW_MIN_ITEMS', `collected ${c.items} items, minimum ${t.minItems}`, { items: c.items, minItems: t.minItems }));
	}
	return { ok: failures.length === 0, failures };
}

// baselineRows: rows written by the last successful full run (null when none).
function checkMatch({ matched, baselineRows }, t, { sample = false } = {}) {
	const failures = [];
	if (!sample && matched < t.minMatched) {
		failures.push(failure('BELOW_MIN_MATCHED', `matched ${matched}, minimum ${t.minMatched}`, { matched, minMatched: t.minMatched }));
	}
	if (!sample && baselineRows > 0 && matched < baselineRows * t.matchDropRatio) {
		failures.push(failure('MATCH_DROP', `matched ${matched}, under ${t.matchDropRatio} of the last full run (${baselineRows})`, { matched, baselineRows, matchDropRatio: t.matchDropRatio }));
	}
	return { ok: failures.length === 0, failures };
}

module.exports = { checkCollection, checkMatch };
