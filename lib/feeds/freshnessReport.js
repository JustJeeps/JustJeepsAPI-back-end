// Feed freshness lines for the daily Cron Activity Digest. Returns results in
// the SAME shape as the buildCronDigestResults lines (server.js),
// { cmd, success, durationMs, logFile, error }, so they can be concatenated
// straight into the e-mail: a stale feed or one with no batch becomes a
// failure line and the digest subject calls it out, instead of today's silence.
//
// Prisma injected as the first parameter (lib/reports/requestsDigest.js pattern).

const catalog = require('./catalog');

async function collectFeedFreshnessResults(prisma, feedDefinitions, { now = new Date() } = {}) {
	const statuses = await catalog.listFeedStatuses(prisma, feedDefinitions, { now });

	return statuses.map((status) => {
		let error = null;
		if (!status.currentBatch) {
			error = `feed "${status.feed}" has no catalogued artifact batch`;
		} else if (status.stale) {
			// Days, and the date the data carries: "1512.3h old" made nobody
			// picture a spreadsheet from March.
			const asOf = status.currentBatch.dataAsOf.toISOString().slice(0, 10);
			const days = (status.ageHours / 24).toFixed(0);
			error = `feed "${status.feed}" data is from ${asOf}, ${days} days old (threshold ${Math.round(status.staleAfterHours / 24)} days)`;
		}

		return {
			cmd: `feed:${status.feed}`,
			success: !error,
			durationMs: null,
			logFile: null,
			error,
		};
	});
}

module.exports = { collectFeedFreshnessResults };
