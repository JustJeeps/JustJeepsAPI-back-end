// Catalog of the feed artifacts (FeedArtifact). Prisma comes in as the first
// parameter (same pattern as lib/reports/requestsDigest.js) so the tests can
// run with an in-memory stub.
//
// Central invariant: a batch (batchId) is only "current" when it covers ALL
// the expected files of the feed with status available, so a partial upload of
// a multi-file feed (Keystone: Inventory + SpecialOrder) stays invisible to
// the consumers until it completes (atomicity on read).

const crypto = require('crypto');

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

// Current batch of the feed: the most recent one whose available artifacts
// cover every expectedFileNames entry. Incomplete or quarantined batches never
// come out of here.
async function getCurrentBatch(prisma, feed, expectedFileNames) {
	const artifacts = await prisma.feedArtifact.findMany({
		where: { feed, status: 'available', fileName: { in: expectedFileNames } },
		orderBy: { uploadedAt: 'desc' },
	});

	const byBatch = new Map();
	for (const artifact of artifacts) {
		if (!byBatch.has(artifact.batchId)) byBatch.set(artifact.batchId, []);
		byBatch.get(artifact.batchId).push(artifact);
	}

	for (const [batchId, batchArtifacts] of byBatch) {
		const names = new Set(batchArtifacts.map((a) => a.fileName));
		if (expectedFileNames.every((name) => names.has(name))) {
			const uploadedAt = batchArtifacts
				.map((a) => a.uploadedAt)
				.sort((a, b) => b - a)[0];
			return { batchId, uploadedAt, artifacts: batchArtifacts };
		}
	}
	return null;
}

// Is there already an object in the bucket with this content for (feed,
// file)? It exists to avoid resending identical bytes: the object is immutable
// and addressed by hash, so a new artifact can safely point at the SAME key.
async function findArtifactByHash(prisma, feed, fileName, sha256) {
	return prisma.feedArtifact.findFirst({
		where: { feed, fileName, sha256 },
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
	const statuses = [];
	for (const feed of feedDefinitions) {
		const currentBatch = await getCurrentBatch(prisma, feed.name, feed.files);
		const [lastRun, lastFetch] = await Promise.all([
			prisma.ingestRun.findFirst({ where: { feed: feed.name }, orderBy: { id: 'desc' } }),
			prisma.ingestRun.findFirst({ where: { feed: `${feed.name}-fetch` }, orderBy: { id: 'desc' } }),
		]);
		const ageHours = currentBatch ? (now - currentBatch.uploadedAt) / 36e5 : null;
		statuses.push({
			feed: feed.name,
			label: feed.label || feed.name,
			files: feed.files,
			staleAfterHours: feed.staleAfterHours,
			maxUploadBytes: feed.maxUploadBytes,
			// Panel "Run now" button (null = feed without its own script).
			seedCommand: feed.seedCommand || null,
			seedCommandNote: feed.seedCommandNote || null,
			currentBatch,
			ageHours,
			stale: ageHours !== null ? ageHours > feed.staleAfterHours : true,
			lastRun,
			lastFetch,
		});
	}
	return statuses;
}

module.exports = {
	registerArtifacts,
	getCurrentBatch,
	findArtifactByHash,
	quarantineBatch,
	listRuns,
	listFeedStatuses,
};
