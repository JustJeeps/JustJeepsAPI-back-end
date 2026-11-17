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
// seedCommand is also the allowlist for the Run now button, so a feed can hide
// the button (warn-map writes to the live store) and still be processed by the
// daily sync. syncCommands lists everything the sync runs for the feed, which
// is what bookkeeping has to follow.
function findFeedByCommand(command) {
	return feedsConfig.getFeedDefinitions().find((feed) =>
		asArray(feed.seedCommand).includes(command) || asArray(feed.syncCommands).includes(command)
	) || null;
}

// Writes the "running" row the moment a panel run starts. This row is what
// survives the process dying in the middle (a deploy, an OOM): on the next
// boot lib/feeds/staleRuns closes it as interrupted, so the panel shows a
// failed run with a reason instead of "never" next to a run that burned an
// hour (seen 2026-11-17 with the CAD store publish).
async function recordScriptRunStart(prisma, { feed, command, startedAt }) {
	if (!prisma || !feed) return null;

	return prisma.ingestRun.create({
		data: {
			feed: feed.ingestFeed || feed.name,
			sourceKind: 'script-run',
			sourceRef: command,
			startedAt: new Date(startedAt),
			status: 'running',
		},
	});
}

async function recordScriptRun(prisma, { feed, command, startedAt, finishedAt, status, error, startRunId = null }) {
	if (!prisma || !feed) return null;

	const ingestFeed = feed.ingestFeed || feed.name;
	const startedAtDate = new Date(startedAt);

	const ownRun = await prisma.ingestRun.findFirst({
		// The start row this same run wrote is not the seed's own run.
		where: {
			feed: ingestFeed,
			startedAt: { gte: startedAtDate },
			...(startRunId ? { id: { not: startRunId } } : {}),
		},
		orderBy: { id: 'desc' },
		select: { id: true, status: true },
	});

	// The seed recorded its own detailed row, so the bookkeeping start row has
	// served its purpose (live visibility) and would only hide the counts.
	const discardStartRow = async () => {
		if (startRunId) {
			await prisma.ingestRun.delete({ where: { id: startRunId } }).catch(() => {});
		}
		return null;
	};

	// Finalize the start row when there is one; create the row late otherwise
	// (the daily seed-all path still calls this with no start row).
	const finalize = (data) => (startRunId
		? prisma.ingestRun.update({ where: { id: startRunId }, data })
		: prisma.ingestRun.create({
			data: {
				feed: ingestFeed,
				sourceKind: 'script-run',
				sourceRef: command,
				startedAt: startedAtDate,
				...data,
			},
		}));

	if (status === 'failed') {
		// The script already filed this failure with the reason ("no such file
		// ... omix-excel.xlsx"). Adding a bookkeeping row on top would be newer,
		// so the panel would show the useless "Exit code 1" instead.
		if (ownRun?.status === 'failed') return discardStartRow();
		// An own run that SUCCEEDED while the command failed means a feed with
		// several scripts (Quadratec applies prices and then inventory) where a
		// later one broke. Without this row the panel shows a green success for
		// a run that did not work.
	} else {
		if (ownRun) return discardStartRow();

		// Feeds whose scripts record their own detailed run (with row counts)
		// never get a bookkeeping row on success: it would be newer and would
		// hide the numbers behind zeros.
		if (feed.recordsOwnRuns) return discardStartRow();
	}

	return finalize({
		finishedAt: finishedAt ? new Date(finishedAt) : new Date(),
		status,
		error: error ? String(error).slice(0, 4000) : null,
	});
}

module.exports = { recordScriptRun, recordScriptRunStart, findFeedByCommand };
