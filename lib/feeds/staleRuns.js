// Closes ingest runs that were left in "running" forever.
//
// A run is marked running when it starts and updated when it ends, so anything
// that kills the process in between (a deploy replacing the container, an OOM,
// a restart) leaves the row open. The panel then shows a fetch or a script that
// is not happening, keeps the "something is running" banner up, and polls every
// 15 seconds in every open tab, forever.
//
// The cutoff is generous on purpose: the longest run in the system is the
// Keystone FTP fetch, which moves 460MB and takes around 20 minutes, and
// seed-all as a whole takes about 25. Anything still open after a few hours is
// a leftover, not work in progress.

const DEFAULT_MAX_AGE_MS = Number(process.env.INGEST_RUN_MAX_AGE_MS || 4 * 60 * 60 * 1000);

async function closeStaleRuns(prisma, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = () => new Date() } = {}) {
	if (!prisma) return 0;
	const cutoff = new Date(now().getTime() - maxAgeMs);

	const result = await prisma.ingestRun.updateMany({
		where: { status: 'running', startedAt: { lt: cutoff } },
		data: {
			status: 'failed',
			finishedAt: now(),
			error: 'Interrupted: the process ended before finishing (no result was recorded)',
		},
	});

	return result.count;
}

module.exports = { closeStaleRuns, DEFAULT_MAX_AGE_MS };
