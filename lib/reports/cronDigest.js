// Per-job lines for the daily Cron Activity Digest, built from the cron
// history entries inside the digest window. Same shape as the feed freshness
// lines (lib/feeds/freshnessReport.js): { cmd, success, durationMs, logFile,
// error, logExcerpt }.
//
// A job is only reported as failed when its LATEST run (ignoring skipped
// runs, which never executed) failed or was interrupted. A failure that a
// later run already recovered from still shows up in the counters
// ("1 succeeded, 1 failed") but no longer turns the job, or the whole
// digest, red: the 2026-09-10 digest called seed-all "Failed" for the run
// that broke at 07:32 even though the 19:32 run had already passed.

const ACTIVE_STATUSES = new Set(['success', 'failed', 'interrupted']);

function entryTimestamp(entry) {
	const timestamp = new Date(entry.finishedAt || entry.startedAt || entry.createdAt || 0).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeStatus(status) {
	if (status === 'success' || status === 'skipped' || status === 'interrupted') return status;
	return 'failed';
}

function summarizeCronDigestEntries(entries = []) {
	const summaries = new Map();

	for (const entry of entries) {
		const key = entry.command || 'unknown';
		const current = summaries.get(key) || {
			command: key,
			jobName: entry.jobName || key,
			total: 0,
			success: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			durationMs: 0,
			errors: [],
			latest: null,
		};

		const status = normalizeStatus(entry.status);
		current.total += 1;
		current[status] += 1;

		if (Number.isFinite(entry.durationMs)) {
			current.durationMs += entry.durationMs;
		}

		if (entry.error) {
			current.errors.push(entry.error);
		}

		if (ACTIVE_STATUSES.has(status)) {
			const timestamp = entryTimestamp(entry);
			if (!current.latest || timestamp >= current.latest.timestamp) {
				current.latest = { status, timestamp };
			}
		}

		summaries.set(key, current);
	}

	return Array.from(summaries.values())
		.sort((left, right) => left.jobName.localeCompare(right.jobName))
		.map((summary) => {
			const hadFailures = summary.failed > 0 || summary.interrupted > 0;
			const latestFailed = Boolean(summary.latest) && summary.latest.status !== 'success';
			const recovered = hadFailures && !latestFailed;
			const statusLine = [
				`${summary.success} succeeded`,
				`${summary.failed} failed`,
				`${summary.skipped} skipped`,
				`${summary.interrupted} interrupted`,
			].join(', ');

			return {
				cmd: `${summary.jobName} (${summary.total} runs)`,
				success: !latestFailed,
				durationMs: summary.durationMs || null,
				logFile: null,
				error: latestFailed
					? summary.errors.slice(0, 3).join(' | ') || 'One or more runs did not complete successfully'
					: null,
				logExcerpt: recovered
					? `${statusLine} (recovered: latest run succeeded)`
					: statusLine,
			};
		});
}

module.exports = { summarizeCronDigestEntries };
