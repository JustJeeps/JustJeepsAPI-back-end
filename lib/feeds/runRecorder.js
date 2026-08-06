// Records the outcome of a vendor script as an IngestRun.
//
// Why this exists: only the seeds built on lib/ingest (Keystone, Quadratec,
// Meyer) record a run of their own. Every other vendor script ran, did its job
// and left no trace, so the panel said "never" next to a feed that had just
// been processed. Both entry points that execute those scripts, the Run now
// button and the daily seed-all, call this so the answer is the same either
// way.
//
// The row is written only when the script did not write one itself, which
// keeps the detailed row (the one carrying the row counts) as the last one for
// the instrumented seeds.

const feedsConfig = require('../../config/feeds');

const asArray = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);

// Which feed does this npm script belong to? A feed may list several scripts.
function findFeedByCommand(command) {
	return feedsConfig.getFeedDefinitions().find((feed) => asArray(feed.seedCommand).includes(command)) || null;
}

async function recordScriptRun(prisma, { feed, command, startedAt, finishedAt, status, error }) {
	if (!prisma || !feed) return null;

	const ingestFeed = feed.ingestFeed || feed.name;
	const startedAtDate = new Date(startedAt);

	const ownRun = await prisma.ingestRun.findFirst({
		where: { feed: ingestFeed, startedAt: { gte: startedAtDate } },
		select: { id: true },
	});
	if (ownRun) return null;

	return prisma.ingestRun.create({
		data: {
			feed: ingestFeed,
			sourceKind: 'script-run',
			sourceRef: command,
			startedAt: startedAtDate,
			finishedAt: finishedAt ? new Date(finishedAt) : new Date(),
			status,
			error: error ? String(error).slice(0, 4000) : null,
		},
	});
}

module.exports = { recordScriptRun, findFeedByCommand };
