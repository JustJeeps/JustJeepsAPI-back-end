const test = require('node:test');
const assert = require('node:assert');

const { createReviewImportService } = require('../../../services/reviews/reviewImportService');
const { createReviewSyncService } = require('../../../services/reviews/reviewSyncService');

// Stub de prisma em memoria cobrindo APENAS os shapes de query usados pelos
// servicos (molde test/lib/feeds/catalog.test.js). Sem banco, sem rede.
function makePrismaStub() {
	const files = [];
	const rows = [];
	const ingestRuns = [];
	let nextId = 1;

	const matchesRow = (row, where = {}) => {
		if (where.id?.in && !where.id.in.includes(row.id)) return false;
		if (typeof where.id === 'number' && row.id !== where.id) return false;
		if (where.fileId !== undefined && row.fileId !== where.fileId) return false;
		if (typeof where.status === 'string' && row.status !== where.status) return false;
		return true;
	};

	return {
		files,
		rows,
		ingestRuns,
		reviewImportFile: {
			findUnique: async ({ where }) => files.find((file) =>
				(where.id !== undefined && file.id === where.id)
				|| (where.sha256 !== undefined && file.sha256 === where.sha256)) || null,
			create: async ({ data }) => {
				if (files.some((file) => file.sha256 === data.sha256)) {
					const error = new Error('unique');
					error.code = 'P2002';
					throw error;
				}
				const file = { id: nextId++, status: 'importing', rowCount: 0, duplicateRowCount: 0, invalidRowCount: 0, objectKey: null, uploadedAt: new Date(), ...data };
				files.push(file);
				return file;
			},
			update: async ({ where, data }) => {
				const file = files.find((entry) => entry.id === where.id);
				Object.assign(file, data);
				return file;
			},
			findMany: async () => [...files].sort((a, b) => b.id - a.id),
		},
		reviewImportRow: {
			createMany: async ({ data, skipDuplicates }) => {
				let count = 0;
				for (const entry of data) {
					if (skipDuplicates && rows.some((row) => row.rowHash === entry.rowHash)) continue;
					rows.push({ id: nextId++, status: 'pending', error: null, syncedAt: null, syncRunId: null, ...entry });
					count += 1;
				}
				return { count };
			},
			findMany: async ({ where, orderBy, take, select } = {}) => {
				let found = rows.filter((row) => matchesRow(row, where));
				if (orderBy?.id === 'asc') found = found.sort((a, b) => a.id - b.id);
				if (take) found = found.slice(0, take);
				if (select) {
					return found.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])));
				}
				return found.map((row) => ({ ...row }));
			},
			updateMany: async ({ where, data }) => {
				let count = 0;
				for (const row of rows) {
					if (matchesRow(row, where)) {
						Object.assign(row, data);
						count += 1;
					}
				}
				return { count };
			},
			groupBy: async ({ where }) => {
				const groups = new Map();
				for (const row of rows) {
					if (where?.fileId?.in && !where.fileId.in.includes(row.fileId)) continue;
					const key = `${row.fileId}|${row.status}`;
					groups.set(key, (groups.get(key) || 0) + 1);
				}
				return [...groups.entries()].map(([key, count]) => {
					const [fileId, status] = key.split('|');
					return { fileId: Number(fileId), status, _count: { _all: count } };
				});
			},
		},
		ingestRun: {
			findFirst: async () => ingestRuns[ingestRuns.length - 1] || null,
			updateMany: async ({ where, data }) => {
				let count = 0;
				for (const run of ingestRuns) {
					if (where.feed && run.feed !== where.feed) continue;
					if (where.status && run.status !== where.status) continue;
					Object.assign(run, data);
					count += 1;
				}
				return { count };
			},
		},
	};
}

const CONFIG = { batchSize: 2, batchDelayMs: 500, maxRows: 60000, insertChunkSize: 2 };

const HEADER = ['sku', 'nickname', 'rating', 'title', 'detail', 'date'];
const sheetRow = (sku, nickname = 'Ana') => [sku, nickname, '5', `Great ${sku}`, `Review text for ${sku}`, '2026-07-12'];
const sheetOf = (...dataRows) => [HEADER, ...dataRows];

function makeImportService(prisma, sheet) {
	return createReviewImportService({
		prisma,
		config: CONFIG,
		parseWorkbookBuffer: () => sheet,
	});
}

const USER = { username: 'rafael' };
const FILE_INPUT = { originalname: 'reviews.xlsx', buffer: Buffer.from('fake'), size: 4 };

test('upload feliz: cria arquivo, insere em chunks, fecha ready com contadores', async () => {
	const prisma = makePrismaStub();
	const service = makeImportService(prisma, sheetOf(sheetRow('SKU-1'), sheetRow('SKU-2'), sheetRow('SKU-3')));

	const result = await service.uploadFile({ user: USER, file: FILE_INPUT });

	assert.strictEqual(result.file.status, 'ready');
	assert.strictEqual(result.file.uploadedBy, 'rafael');
	assert.deepStrictEqual(result.counts, { rows: 3, inserted: 3, duplicates: 0, invalid: 0 });
	assert.strictEqual(prisma.rows.length, 3);
	assert.ok(prisma.rows.every((row) => row.status === 'pending'));
});

test('mesmo arquivo (sha) ja importado responde 409 DUPLICATE_FILE', async () => {
	const prisma = makePrismaStub();
	const service = makeImportService(prisma, sheetOf(sheetRow('SKU-1')));
	await service.uploadFile({ user: USER, file: FILE_INPUT });

	await assert.rejects(service.uploadFile({ user: USER, file: FILE_INPUT }), (error) => {
		assert.strictEqual(error.code, 'DUPLICATE_FILE');
		assert.strictEqual(error.httpStatus, 409);
		return true;
	});
});

test('upload que morreu no meio (importing) retoma a insercao de forma idempotente', async () => {
	const prisma = makePrismaStub();
	const sheet = sheetOf(sheetRow('SKU-1'), sheetRow('SKU-2'));
	const service = makeImportService(prisma, sheet);
	await service.uploadFile({ user: USER, file: FILE_INPUT });
	// simula crash: arquivo volta a importing e uma linha "ja existia"
	prisma.files[0].status = 'importing';
	prisma.rows.splice(1); // sobrou so SKU-1

	const result = await service.uploadFile({ user: USER, file: FILE_INPUT });

	assert.strictEqual(result.file.status, 'ready');
	assert.strictEqual(prisma.rows.length, 2);
	assert.strictEqual(result.counts.inserted, 1); // so a que faltava
	assert.strictEqual(prisma.files.length, 1); // nenhum arquivo duplicado
});

test('linha repetida em OUTRO arquivo vira duplicateRowCount (rowHash global)', async () => {
	const prisma = makePrismaStub();
	const first = makeImportService(prisma, sheetOf(sheetRow('SKU-1'), sheetRow('SKU-2')));
	await first.uploadFile({ user: USER, file: FILE_INPUT });

	const second = makeImportService(prisma, sheetOf(sheetRow('SKU-2'), sheetRow('SKU-9')));
	const result = await second.uploadFile({ user: USER, file: { ...FILE_INPUT, buffer: Buffer.from('other') } });

	assert.deepStrictEqual(result.counts, { rows: 2, inserted: 1, duplicates: 1, invalid: 0 });
	assert.strictEqual(result.file.duplicateRowCount, 1);
});

test('planilha sem nenhuma linha valida responde 400', async () => {
	const prisma = makePrismaStub();
	const service = makeImportService(prisma, sheetOf(['', 'Ana', '9', 'T', 'D', 'bad-date']));
	await assert.rejects(service.uploadFile({ user: USER, file: FILE_INPUT }), (error) => error.httpStatus === 400);
});

test('staging no Spaces: sobe em review-imports/ antes das linhas e apaga ao fechar ready', async () => {
	const prisma = makePrismaStub();
	const calls = { puts: [], deletes: [] };
	const store = {
		isConfigured: () => true,
		putStream: async ({ key }) => { calls.puts.push(key); },
		deleteObject: async (key) => { calls.deletes.push(key); },
	};
	const service = createReviewImportService({
		prisma,
		config: CONFIG,
		parseWorkbookBuffer: () => sheetOf(sheetRow('SKU-1')),
		store,
		now: () => new Date('2026-08-25T12:00:00Z'),
	});

	const result = await service.uploadFile({ user: USER, file: FILE_INPUT });

	assert.strictEqual(calls.puts.length, 1);
	assert.match(calls.puts[0], /^review-imports\/2026\/08\/20260825T120000Z-[a-f0-9]{8}-reviews\.xlsx$/);
	assert.deepStrictEqual(calls.deletes, calls.puts); // apagado ao fechar
	assert.strictEqual(result.file.objectKey, null);
});

test('staging: Spaces fora do ar nao bloqueia o import; falha no delete preserva a chave', async () => {
	const prisma = makePrismaStub();
	const down = {
		isConfigured: () => true,
		putStream: async () => { throw new Error('spaces down'); },
		deleteObject: async () => { throw new Error('spaces down'); },
	};
	const service = createReviewImportService({
		prisma,
		config: CONFIG,
		parseWorkbookBuffer: () => sheetOf(sheetRow('SKU-1')),
		store: down,
		logger: { warn: () => {} },
	});
	const result = await service.uploadFile({ user: USER, file: FILE_INPUT });
	assert.strictEqual(result.file.status, 'ready'); // import passou mesmo assim
	assert.strictEqual(result.file.objectKey, null);

	// delete falhando: chave preservada para limpeza posterior
	const prisma2 = makePrismaStub();
	const flaky = {
		isConfigured: () => true,
		putStream: async () => {},
		deleteObject: async () => { throw new Error('delete failed'); },
	};
	const service2 = createReviewImportService({
		prisma: prisma2,
		config: CONFIG,
		parseWorkbookBuffer: () => sheetOf(sheetRow('SKU-2')),
		store: flaky,
		logger: { warn: () => {} },
	});
	const result2 = await service2.uploadFile({ user: USER, file: { ...FILE_INPUT, buffer: Buffer.from('two') } });
	assert.strictEqual(result2.file.status, 'ready');
	assert.match(result2.file.objectKey, /^review-imports\//);
});

test('listFiles agrega contadores por status e amostra de erros so quando ha falhas', async () => {
	const prisma = makePrismaStub();
	const service = makeImportService(prisma, sheetOf(sheetRow('SKU-1'), sheetRow('SKU-2')));
	await service.uploadFile({ user: USER, file: FILE_INPUT });
	prisma.rows[0].status = 'failed';
	prisma.rows[0].error = 'MAGENTO_BAD_REQUEST';

	const listing = await service.listFiles();

	assert.strictEqual(listing.files.length, 1);
	assert.deepStrictEqual(listing.files[0].counts, { pending: 1, sending: 0, synced: 0, failed: 1 });
	assert.strictEqual(listing.files[0].errorSamples.length, 1);
	assert.strictEqual(listing.files[0].errorSamples[0].error, 'MAGENTO_BAD_REQUEST');
	assert.strictEqual(listing.running, false);
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function makeSyncHarness(prisma, { post, get } = {}) {
	const sleeps = [];
	const finishes = [];
	const lockState = { held: false };
	const magentoCalls = { posts: [], gets: [] };
	const magentoClient = {
		isConfigured: () => true,
		postReviewsBulk: async (reviews) => {
			magentoCalls.posts.push(reviews);
			return post ? post(reviews, magentoCalls.posts.length) : { status: 200 };
		},
		getReviewsBySku: async (sku) => {
			magentoCalls.gets.push(sku);
			return get ? get(sku) : [];
		},
	};
	const service = createReviewSyncService({
		prisma,
		magentoClient,
		config: CONFIG,
		ingestRuns: {
			startRun: async (feed, options) => {
				const run = { id: 900 + finishes.length, feed, ...options };
				prisma.ingestRuns.push({ ...run, status: 'running' });
				return {
					id: run.id,
					finish: async (outcome) => { finishes.push({ runId: run.id, ...outcome }); },
				};
			},
		},
		locks: {
			acquireIngestLock: async () => {
				if (lockState.held) return false;
				lockState.held = true;
				return true;
			},
			renewIngestLock: async () => { lockState.renewals = (lockState.renewals || 0) + 1; },
			releaseIngestLock: async () => { lockState.held = false; },
		},
		retries: {
			withRetry: (fn) => fn(),
			withConcurrency: async (items, limit, iterator) => {
				for (const item of items) await iterator(item);
			},
		},
		sleep: async (ms) => { sleeps.push(ms); },
		logger: { warn: () => {} },
	});
	return { service, sleeps, finishes, lockState, magentoCalls };
}

async function seedFile(prisma, skus) {
	const service = makeImportService(prisma, sheetOf(...skus.map((sku) => sheetRow(sku))));
	const { file } = await service.uploadFile({ user: USER, file: FILE_INPUT });
	return file;
}

test('caminho feliz: lotes de batchSize, write-ahead sending, synced com delay entre lotes', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1', 'SKU-2', 'SKU-3']);
	const { service, sleeps, finishes, magentoCalls, lockState } = makeSyncHarness(prisma);

	const { runId, done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.ok(runId >= 900);
	assert.strictEqual(magentoCalls.posts.length, 2); // 2 + 1 com batchSize 2
	assert.deepStrictEqual(magentoCalls.posts[0].map((review) => review.sku), ['SKU-1', 'SKU-2']);
	assert.ok(prisma.rows.every((row) => row.status === 'synced' && row.syncedAt && row.syncRunId === runId));
	assert.deepStrictEqual(sleeps, [500, 500]);
	assert.strictEqual(finishes[0].status, 'success');
	assert.strictEqual(finishes[0].counts.inserted, 3);
	assert.strictEqual(lockState.held, false);
});

test('lock ocupado responde 409 SYNC_ALREADY_RUNNING', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1']);
	const { service, lockState } = makeSyncHarness(prisma);
	lockState.held = true;

	await assert.rejects(service.startSync({ user: USER, fileId: file.id }), (error) => error.code === 'SYNC_ALREADY_RUNNING');
});

test('arquivo inexistente 404; arquivo importing 409', async () => {
	const prisma = makePrismaStub();
	const { service } = makeSyncHarness(prisma);
	await assert.rejects(service.startSync({ user: USER, fileId: 999 }), (error) => error.httpStatus === 404);

	const file = await seedFile(prisma, ['SKU-1']);
	prisma.files[0].status = 'importing';
	await assert.rejects(service.startSync({ user: USER, fileId: file.id }), (error) => error.code === 'FILE_NOT_READY');
});

test('recuperacao: sending casada vira synced, ausente volta a pending e e reenviada', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-A', 'SKU-B']);
	prisma.rows[0].status = 'sending'; // SKU-A: ja esta no Magento
	prisma.rows[1].status = 'sending'; // SKU-B: nao chegou
	const { service, finishes, magentoCalls } = makeSyncHarness(prisma, {
		get: (sku) => (sku === 'SKU-A'
			? [{ nickname: 'Ana', summary: 'Great SKU-A', created_at: '2026-07-12 12:00:00' }]
			: []),
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.strictEqual(prisma.rows[0].status, 'synced');
	assert.strictEqual(prisma.rows[1].status, 'synced'); // requeued e enviada de novo
	assert.strictEqual(magentoCalls.posts.length, 1);
	assert.deepStrictEqual(magentoCalls.posts[0].map((review) => review.sku), ['SKU-B']);
	assert.strictEqual(finishes[0].counts.updated, 1); // recuperada
});

test('recuperacao bloqueada (GET falhou): nada e enviado, linhas ficam sending, run failed', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-A', 'SKU-B']);
	prisma.rows[0].status = 'sending';
	const { service, finishes, magentoCalls, lockState } = makeSyncHarness(prisma, {
		get: () => { const error = new Error('down'); error.code = 'MAGENTO_UNAVAILABLE'; throw error; },
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.strictEqual(prisma.rows[0].status, 'sending');
	assert.strictEqual(magentoCalls.posts.length, 0);
	assert.strictEqual(finishes[0].status, 'failed');
	assert.strictEqual(finishes[0].error, 'RECOVERY_BLOCKED');
	assert.strictEqual(lockState.held, false);
});

test('shape ilegivel na verificacao tambem bloqueia (nunca assume ausente)', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-A']);
	prisma.rows[0].status = 'sending';
	const { service, finishes, magentoCalls } = makeSyncHarness(prisma, {
		get: () => [{ foo: 'bar' }],
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.strictEqual(prisma.rows[0].status, 'sending');
	assert.strictEqual(magentoCalls.posts.length, 0);
	assert.strictEqual(finishes[0].error, 'RECOVERY_BLOCKED');
});

test('POST 4xx (desfecho conhecido): lote vira failed e o loop SEGUE', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1', 'SKU-2', 'SKU-3']);
	const { service, finishes } = makeSyncHarness(prisma, {
		post: (reviews, callNumber) => {
			if (callNumber === 1) {
				const error = new Error('bad');
				error.code = 'MAGENTO_BAD_REQUEST';
				error.outcomeKnown = true;
				throw error;
			}
			return { status: 200 };
		},
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	const statuses = prisma.rows.map((row) => row.status);
	assert.deepStrictEqual(statuses, ['failed', 'failed', 'synced']);
	assert.strictEqual(prisma.rows[0].error, 'MAGENTO_BAD_REQUEST');
	assert.strictEqual(finishes[0].status, 'success');
	assert.strictEqual(finishes[0].counts.skipped, 2);
	assert.strictEqual(finishes[0].counts.inserted, 1);
});

test('POST com desfecho DESCONHECIDO (timeout): linhas ficam sending e o run para', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1', 'SKU-2', 'SKU-3']);
	const { service, finishes, magentoCalls } = makeSyncHarness(prisma, {
		post: () => {
			const error = new Error('timeout');
			error.code = 'MAGENTO_UNAVAILABLE';
			error.outcomeKnown = false;
			throw error;
		},
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.deepStrictEqual(prisma.rows.map((row) => row.status), ['sending', 'sending', 'pending']);
	assert.strictEqual(magentoCalls.posts.length, 1); // NUNCA re-tenta desfecho ambiguo
	assert.strictEqual(finishes[0].status, 'failed');
});

test('429 e retryado com backoff e o lote conclui', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1']);
	const { service, finishes, magentoCalls, sleeps } = makeSyncHarness(prisma, {
		post: (reviews, callNumber) => {
			if (callNumber === 1) {
				const error = new Error('rate');
				error.code = 'MAGENTO_RATE_LIMITED';
				error.outcomeKnown = true;
				throw error;
			}
			return { status: 200 };
		},
	});

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.strictEqual(magentoCalls.posts.length, 2);
	assert.strictEqual(prisma.rows[0].status, 'synced');
	assert.strictEqual(finishes[0].status, 'success');
	assert.ok(sleeps.includes(1000)); // backoff do retry
});

test('lease e renovado a cada lote e runs orfaos viram failed ao adquirir o lock', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1', 'SKU-2', 'SKU-3']);
	prisma.ingestRuns.push({ id: 1, feed: 'magento-reviews', status: 'running' }); // orfao de um crash
	const { service, lockState } = makeSyncHarness(prisma);

	const { done } = await service.startSync({ user: USER, fileId: file.id });
	await done;

	assert.strictEqual(lockState.renewals, 2); // um por lote (batchSize 2 -> 2 lotes)
	assert.strictEqual(prisma.ingestRuns[0].status, 'failed');
	assert.strictEqual(prisma.ingestRuns[0].error, 'INTERRUPTED');
});

test('retryFailed reenfileira so as failed; markSendingFailed e o escape manual', async () => {
	const prisma = makePrismaStub();
	const file = await seedFile(prisma, ['SKU-1', 'SKU-2']);
	prisma.rows[0].status = 'failed';
	prisma.rows[1].status = 'sending';
	const { service } = makeSyncHarness(prisma);

	assert.deepStrictEqual(await service.retryFailed({ fileId: file.id }), { requeued: 1 });
	assert.strictEqual(prisma.rows[0].status, 'pending');
	assert.deepStrictEqual(await service.markSendingFailed({ fileId: file.id }), { marked: 1 });
	assert.strictEqual(prisma.rows[1].status, 'failed');
});
