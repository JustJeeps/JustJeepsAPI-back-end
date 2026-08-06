// Catalog of the feed artifacts (FeedArtifact). Prisma comes in as the first
// parameter (same pattern as lib/reports/requestsDigest.js) so the tests can
// run with an in-memory stub.
//
// Central invariant: a batch (batchId) is only "current" when it covers ALL
// the expected files of the feed with status available, so a partial upload of
// a multi-file feed (Keystone: Inventory + SpecialOrder) stays invisible to
// the consumers until it completes (atomicity on read).

const crypto = require('crypto');
const { closeStaleRuns } = require('./staleRuns');

// Marks the previous available artifacts of the SAME (feed, fileName) as
// superseded and inserts the new ones in a single transaction.
async function registerArtifacts(prisma, { feed, batchId, source, uploadedBy = null, note = null, files }) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new Error('registerArtifacts: files is empty');
	}
	const resolvedBatchId = batchId || crypto.randomUUID();
	const fileNames = files.map((file) => file.fileName);

	const created = await prisma.$transaction(async (tx) => {
		await tx.feedArtifact.updateMany({
			where: { feed, fileName: { in: fileNames }, status: 'available' },
			data: { status: 'superseded' },
		});
		const rows = [];
		for (const file of files) {
			rows.push(await tx.feedArtifact.create({
				data: {
					feed,
					fileName: file.fileName,
					batchId: resolvedBatchId,
					objectKey: file.objectKey,
					sha256: file.sha256,
					sizeBytes: BigInt(file.sizeBytes),
					contentType: file.contentType || null,
					source,
					uploadedBy,
					note,
				},
			}));
		}
		return rows;
	});

	return { batchId: resolvedBatchId, artifacts: created };
}

// Picks the newest batch that covers every expected file, from artifacts that
// are already loaded. Shared by getCurrentBatch (one feed, one query) and by
// listFeedStatuses (every feed on the page, also one query).
function pickCurrentBatch(artifacts, expectedFileNames) {
	const byBatch = new Map();
	for (const artifact of artifacts) {
		if (!byBatch.has(artifact.batchId)) byBatch.set(artifact.batchId, []);
		byBatch.get(artifact.batchId).push(artifact);
	}

	for (const [batchId, batchArtifacts] of byBatch) {
		const names = new Set(batchArtifacts.map((a) => a.fileName));
		if (expectedFileNames.every((name) => names.has(name))) {
			const uploadedAt = batchArtifacts.map((a) => a.uploadedAt).sort((a, b) => b - a)[0];
			return { batchId, uploadedAt, artifacts: batchArtifacts };
		}
	}
	return null;
}

// Current batch of the feed: the most recent one whose available artifacts
// cover every expectedFileNames entry. Incomplete or quarantined batches never
// come out of here.
async function getCurrentBatch(prisma, feed, expectedFileNames) {
	const artifacts = await prisma.feedArtifact.findMany({
		where: { feed, status: 'available', fileName: { in: expectedFileNames } },
		orderBy: { uploadedAt: 'desc' },
	});

	return pickCurrentBatch(artifacts, expectedFileNames);
}

// Is there already an object in the bucket with this content for (feed,
// file)? It exists to avoid resending identical bytes: the object is immutable
// and addressed by hash, so a new artifact can safely point at the SAME key.
//
// Quarantined rows are excluded on purpose: quarantine is the kill switch for
// content found to be bad, and matching one here would hand the same bytes back
// to the next upload as "already stored, nothing to send".
async function findArtifactByHash(prisma, feed, fileName, sha256) {
	return prisma.feedArtifact.findFirst({
		where: { feed, fileName, sha256, status: { not: 'quarantined' } },
		orderBy: { uploadedAt: 'desc' },
	});
}

// Manual kill switch for a bad batch: it disappears from getCurrentBatch and
// the materializer falls back to the previous complete batch (if there is one).
async function quarantineBatch(prisma, batchId, note) {
	return prisma.feedArtifact.updateMany({
		where: { batchId },
		data: { status: 'quarantined', ...(note ? { note } : {}) },
	});
}

async function listRuns(prisma, { feed, status, limit = 50, offset = 0 } = {}) {
	const where = {
		...(feed ? { feed } : {}),
		...(status ? { status } : {}),
	};
	const [runs, total] = await Promise.all([
		prisma.ingestRun.findMany({ where, orderBy: { id: 'desc' }, take: limit, skip: offset }),
		prisma.ingestRun.count({ where }),
	]);
	return { runs, total };
}

// Consolidated view for the panel/digest: current batch + last consumption run
// + last fetch run per feed.
async function listFeedStatuses(prisma, feedDefinitions, { now = new Date() } = {}) {
	// Runs abandoned by a restart are closed before reading, otherwise the panel
	// reports work that is not happening and polls for it forever.
	await closeStaleRuns(prisma, { now: () => now }).catch((error) =>
		console.warn(`Could not close stale runs: ${error.message}`));

	// Two queries for the whole page instead of three per feed: the panel
	// refreshes every 15s while anything runs, on a single vCPU box.
	const feedNames = feedDefinitions.map((feed) => feed.name);
	const runFeeds = [
		...new Set(feedDefinitions.flatMap((feed) => [feed.ingestFeed || feed.name, `${feed.name}-fetch`])),
	];

	const [artifacts, runs] = await Promise.all([
		prisma.feedArtifact.findMany({
			where: { feed: { in: feedNames }, status: 'available' },
			orderBy: { uploadedAt: 'desc' },
		}),
		prisma.ingestRun.findMany({
			where: { feed: { in: runFeeds } },
			orderBy: { id: 'desc' },
			take: 200,
		}),
	]);

	const latestRunByFeed = new Map();
	for (const run of runs) {
		if (!latestRunByFeed.has(run.feed)) latestRunByFeed.set(run.feed, run);
	}

	return feedDefinitions.map((feed) => {
		const currentBatch = pickCurrentBatch(
			artifacts.filter((artifact) => artifact.feed === feed.name),
			feed.files
		);
		const ageHours = currentBatch ? (now - currentBatch.uploadedAt) / 36e5 : null;

		return {
			feed: feed.name,
			label: feed.label || feed.name,
			ingestFeed: feed.ingestFeed || feed.name,
			files: feed.files,
			staleAfterHours: feed.staleAfterHours,
			maxUploadBytes: feed.maxUploadBytes,
			seedCommand: feed.seedCommand || null,
			seedCommandNote: feed.seedCommandNote || null,
			currentBatch,
			ageHours,
			stale: ageHours !== null ? ageHours > feed.staleAfterHours : true,
			lastRun: latestRunByFeed.get(feed.ingestFeed || feed.name) || null,
			lastFetch: latestRunByFeed.get(`${feed.name}-fetch`) || null,
		};
	});
}

module.exports = {
	registerArtifacts,
	getCurrentBatch,
	findArtifactByHash,
	quarantineBatch,
	listRuns,
	listFeedStatuses,
};
