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

// On boot the cutoff can be much shorter. Scripts are children of the API
// process, so they die with the container that started them, and Kamal stops
// the outgoing container within a minute of the new one passing its health
// check. Anything still marked running and older than this belongs to a
// container that is already gone or is about to be. It stays a few minutes
// rather than zero so a run that started moments before the swap is never
// declared dead while its process is still finishing.
const BOOT_MAX_AGE_MS = Number(process.env.INGEST_RUN_BOOT_MAX_AGE_MS || 5 * 60 * 1000);

async function closeStaleRuns(prisma, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = () => new Date() } = {}) {
	if (!prisma) return 0;
	const cutoff = new Date(now().getTime() - maxAgeMs);

	// A run whose feed holds a LIVE ingest lease is not an orphan: the lease
	// owner renews it every batch (the reviews sync renews a 5min lease). This
	// matters because the shared production Postgres is also reachable from dev
	// machines: on 2026-08-25 a locally started server booted, ran the 5min
	// boot cleanup and marked the container's legitimately running reviews sync
	// as interrupted while it kept working. Best-effort on purpose: the lease
	// check failing must never block closing genuinely dead runs.
	let protectedFeeds = [];
	try {
		const activeLeases = await prisma.syncState.findMany({
			where: { key: { startsWith: 'ingest-lock:' }, lockedUntil: { gt: now() } },
			select: { key: true },
		});
		protectedFeeds = activeLeases.map((row) => row.key.slice('ingest-lock:'.length));
	} catch (error) {
		protectedFeeds = [];
	}

	const result = await prisma.ingestRun.updateMany({
		where: {
			status: 'running',
			startedAt: { lt: cutoff },
			...(protectedFeeds.length ? { feed: { notIn: protectedFeeds } } : {}),
		},
		data: {
			status: 'failed',
			finishedAt: now(),
			error: 'Interrupted: the process ended before finishing (no result was recorded)',
		},
	});

	return result.count;
}

module.exports = { closeStaleRuns, DEFAULT_MAX_AGE_MS, BOOT_MAX_AGE_MS };
