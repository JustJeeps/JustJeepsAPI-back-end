// Catalogo dos artefatos de feed (FeedArtifact). Prisma entra como primeiro
// parametro (mesmo padrao de lib/reports/requestsDigest.js) para os testes
// rodarem com stub em memoria.
//
// Invariante central: um lote (batchId) so e "corrente" quando cobre TODOS os
// arquivos esperados do feed com status available — upload parcial de um feed
// multi-arquivo (Keystone: Inventory + SpecialOrder) fica invisivel para os
// consumidores ate completar (atomicidade na leitura).

const crypto = require('crypto');

// Marca como superseded os artefatos available anteriores dos MESMOS
// (feed, fileName) e insere os novos numa transacao so.
async function registerArtifacts(prisma, { feed, batchId, source, uploadedBy = null, note = null, files }) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new Error('registerArtifacts: files vazio');
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

// Lote corrente do feed: o mais recente cujos artefatos available cobrem
// todos os expectedFileNames. Lotes incompletos/quarentenados nunca saem daqui.
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

// Kill switch manual para lote ruim: some do getCurrentBatch e o materializer
// volta para o lote completo anterior (se existir).
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

// Visao consolidada para painel/digest: lote corrente + ultimo run de consumo
// + ultimo run de fetch por feed.
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
			// Botao "Run now" do painel (null = feed sem script proprio).
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
	quarantineBatch,
	listRuns,
	listFeedStatuses,
};
