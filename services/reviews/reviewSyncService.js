// Sync das reviews com o Magento de PRODUCAO — o coracao da resiliencia
// (docs/REVIEWS-IMPORT.md). Regras inegociaveis:
//
// 1. Lote e write-ahead: as linhas viram 'sending' (commit) ANTES do POST.
//    'pending' = com certeza nao foi enviado; 'sending' = desfecho desconhecido.
// 2. NUNCA reenviar apos desfecho ambiguo (timeout/5xx): o Magento pode ter
//    gravado. Retry automatico so para 429 e conexao recusada (outcomeKnown).
// 3. Todo run comeca recuperando as 'sending' orfas (de QUALQUER arquivo):
//    GET por SKU + matchReview. Casou -> synced; comprovadamente ausente ->
//    pending; inverificavel -> o run aborta e nada e enviado. Nunca se assume
//    ausencia sem prova — o lado Magento pode nao ter dedup.
// 4. Um sync por vez: lease lock cross-process CURTO (5min) RENOVADO a cada
//    lote — holder vivo nunca perde o lock, holder morto libera em minutos e
//    o operador retoma logo ("assim que voltar"). Ao adquirir, runs 'running'
//    orfaos do feed viram failed (sem esperar o closeStaleRuns de 4h).
//
// PII nunca em log nem em IngestRun.error: so codigos, contagens e ids.

const { toMagentoPayload, matchReview } = require('../../lib/reviews/reviewRows');
const { ReviewsServiceError } = require('./errors');
const { FEED } = require('./reviewImportService');

const POST_RETRY_ATTEMPTS = 3;
const RECOVERY_GET_ATTEMPTS = 3;
const RECOVERY_CONCURRENCY = 2;
const LOCK_LEASE_MINUTES = 5; // renovado a cada lote — ver comentario do topo

class RecoveryBlockedError extends Error {
	constructor(skuCount) {
		super(`recovery blocked: could not verify rows for ${skuCount} sku(s) — nothing was sent`);
		this.code = 'RECOVERY_BLOCKED';
	}
}

function createReviewSyncService({
	prisma,
	magentoClient,
	config,
	ingestRuns = require('../../lib/ingest/ingestRun'),
	locks = require('../../lib/ingest/runLock'),
	retries = require('../../lib/ingest/withRetry'),
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	logger = console,
	now = () => new Date(),
} = {}) {
	// POST com retry APENAS quando o desfecho e conhecido e nada foi processado
	// (429 / conexao recusada). Qualquer outro erro sobe na hora.
	async function postBatchWithSafeRetry(payloads) {
		let lastError;
		for (let attempt = 1; attempt <= POST_RETRY_ATTEMPTS; attempt += 1) {
			try {
				return await magentoClient.postReviewsBulk(payloads);
			} catch (error) {
				lastError = error;
				const retryable = error.outcomeKnown === true
					&& (error.code === 'MAGENTO_RATE_LIMITED' || error.code === 'MAGENTO_UNAVAILABLE');
				if (!retryable || attempt === POST_RETRY_ATTEMPTS) throw error;
				await sleep(1000 * attempt);
			}
		}
		throw lastError;
	}

	// Fase 1: recuperacao global das 'sending' orfas.
	async function recoverSendingRows() {
		const sendingRows = await prisma.reviewImportRow.findMany({
			where: { status: 'sending' },
			orderBy: { id: 'asc' },
		});
		if (!sendingRows.length) return { recovered: 0, requeued: 0 };

		const bySku = new Map();
		for (const row of sendingRows) {
			if (!bySku.has(row.sku)) bySku.set(row.sku, []);
			bySku.get(row.sku).push(row);
		}

		let recovered = 0;
		let requeued = 0;
		const blockedSkus = [];
		await retries.withConcurrency([...bySku.keys()], RECOVERY_CONCURRENCY, async (sku) => {
			let reviews;
			try {
				// GET e idempotente: retry livre.
				reviews = await retries.withRetry(
					() => magentoClient.getReviewsBySku(sku),
					`reviews recovery ${sku}`,
					{ maxRetries: RECOVERY_GET_ATTEMPTS }
				);
			} catch (error) {
				blockedSkus.push(sku);
				return;
			}
			for (const row of bySku.get(sku)) {
				const verdict = matchReview(row, reviews);
				if (verdict === 'matched') {
					await prisma.reviewImportRow.updateMany({
						where: { id: row.id, status: 'sending' },
						data: { status: 'synced', syncedAt: now() },
					});
					recovered += 1;
				} else if (verdict === 'absent') {
					await prisma.reviewImportRow.updateMany({
						where: { id: row.id, status: 'sending' },
						data: { status: 'pending' },
					});
					requeued += 1;
				} else {
					blockedSkus.push(sku);
				}
			}
		});

		if (blockedSkus.length) throw new RecoveryBlockedError(new Set(blockedSkus).size);
		return { recovered, requeued };
	}

	// Fase 2: lotes de 'pending' do arquivo pedido.
	async function sendPendingRows(run, fileId, counts) {
		for (;;) {
			const batch = await prisma.reviewImportRow.findMany({
				where: { fileId, status: 'pending' },
				orderBy: { id: 'asc' },
				take: config.batchSize,
			});
			if (!batch.length) return;

			const ids = batch.map((row) => row.id);
			// Holder vivo renova o lease a cada lote (lease curto + renovacao).
			await locks.renewIngestLock(FEED, { leaseMinutes: LOCK_LEASE_MINUTES });
			// Write-ahead: 'sending' commitado antes do POST.
			await prisma.reviewImportRow.updateMany({
				where: { id: { in: ids } },
				data: { status: 'sending', syncRunId: run.id },
			});
			try {
				await postBatchWithSafeRetry(batch.map(toMagentoPayload));
				await prisma.reviewImportRow.updateMany({
					where: { id: { in: ids } },
					data: { status: 'synced', syncedAt: now() },
				});
				counts.inserted += batch.length;
			} catch (error) {
				if (error.outcomeKnown === false) {
					// Desfecho desconhecido: linhas ficam 'sending' para a
					// recuperacao do proximo run. Nao ha o que decidir agora.
					throw error;
				}
				await prisma.reviewImportRow.updateMany({
					where: { id: { in: ids } },
					data: { status: 'failed', error: String(error.code || error.message).slice(0, 200) },
				});
				counts.skipped += batch.length;
			}
			await sleep(config.batchDelayMs);
		}
	}

	async function executeSync(run, fileId, counts) {
		const recovery = await recoverSendingRows();
		counts.updated = recovery.recovered; // recuperadas contam como "updated" no IngestRun
		await sendPendingRows(run, fileId, counts);
	}

	// Dispara o sync e devolve na hora (a rota responde 202 + runId); o loop
	// roda fire-and-forget e SEMPRE fecha o run e solta o lock.
	async function startSync({ user, fileId }) {
		const file = await prisma.reviewImportFile.findUnique({ where: { id: fileId } });
		if (!file) throw ReviewsServiceError.notFound();
		if (file.status !== 'ready') {
			throw ReviewsServiceError.conflict('FILE_NOT_READY', 'This file is still being processed');
		}
		if (!magentoClient.isConfigured()) {
			throw ReviewsServiceError.conflict('MAGENTO_NOT_CONFIGURED', 'MAGENTO_KEY is not configured');
		}
		const locked = await locks.acquireIngestLock(FEED, { leaseMinutes: LOCK_LEASE_MINUTES });
		if (!locked) {
			throw ReviewsServiceError.conflict('SYNC_ALREADY_RUNNING', 'A reviews sync is already running');
		}

		// So o dono do lock fecha runs 'running' orfaos (processo que morreu):
		// tira o painel do estado "running" eterno sem esperar o closeStaleRuns.
		await prisma.ingestRun.updateMany({
			where: { feed: FEED, status: 'running' },
			data: { status: 'failed', finishedAt: now(), error: 'INTERRUPTED' },
		}).catch(() => {});

		let run;
		try {
			run = await ingestRuns.startRun(FEED, {
				sourceKind: 'api',
				sourceRef: `file:${fileId}`,
				startedBy: user.username,
			});
		} catch (error) {
			await locks.releaseIngestLock(FEED).catch(() => {});
			throw error;
		}

		const loop = (async () => {
			const counts = { inserted: 0, updated: 0, skipped: 0 };
			try {
				await executeSync(run, fileId, counts);
				await run.finish({ status: 'success', counts });
			} catch (error) {
				// So codigo/contagem no error do run — nunca payload de linha.
				await run.finish({
					status: 'failed',
					counts,
					error: String(error.code || 'SYNC_FAILED'),
				}).catch(() => {});
				logger.warn?.(`reviews sync run ${run.id} failed: ${error.code || 'SYNC_FAILED'}`);
			} finally {
				await locks.releaseIngestLock(FEED).catch(() => {});
			}
		})();

		return { runId: run.id, done: loop };
	}

	async function retryFailed({ fileId }) {
		const result = await prisma.reviewImportRow.updateMany({
			where: { fileId, status: 'failed' },
			data: { status: 'pending', error: null },
		});
		return { requeued: result.count };
	}

	// Escape hatch MANUAL (CLI): usar somente depois de conferir no Magento
	// que as linhas 'sending' nao foram gravadas la.
	async function markSendingFailed({ fileId }) {
		const result = await prisma.reviewImportRow.updateMany({
			where: { fileId, status: 'sending' },
			data: { status: 'failed', error: 'manually marked failed (operator verified Magento)' },
		});
		return { marked: result.count };
	}

	return { startSync, retryFailed, markSendingFailed };
}

module.exports = { createReviewSyncService, RecoveryBlockedError };
