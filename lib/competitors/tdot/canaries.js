// Fail-loud checks before any write (DD-019, data seat). A run that could not
// reach Klevu, matched almost nothing or saw too many broken prices must
// abort: a silent thin write is worse than a missing run.

const DEFAULT_THRESHOLDS = Object.freeze({
	minMatched: 200,
	maxFailedRequestRatio: 0.1,
	maxInvalidRatio: 0.02,
});

function checkTdotRun({ requests = 0, failedRequests = 0, matched = 0, rawCount = 0, invalidCount = 0 } = {}, thresholds) {
	const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
	const failures = [];

	if (requests > 0 && failedRequests / requests > t.maxFailedRequestRatio) {
		failures.push({
			code: 'REQUEST_FAILED_RATIO',
			message: `${failedRequests} of ${requests} requests failed (max ratio ${t.maxFailedRequestRatio})`,
			detail: { requests, failedRequests, maxFailedRequestRatio: t.maxFailedRequestRatio },
		});
	}
	if (matched < t.minMatched) {
		failures.push({ code: 'BELOW_MIN_MATCHED', message: `matched ${matched}, minimum ${t.minMatched}`, detail: { matched, minMatched: t.minMatched } });
	}
	if (rawCount > 0 && invalidCount / rawCount > t.maxInvalidRatio) {
		failures.push({ code: 'PRICE_INVALID_RATIO', message: `${invalidCount} of ${rawCount} records had no usable price or part number`, detail: { invalidCount, rawCount } });
	}

	return { ok: failures.length === 0, failures, stats: { requests, failedRequests, matched, rawCount, invalidCount } };
}

module.exports = { DEFAULT_THRESHOLDS, checkTdotRun };
