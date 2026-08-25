// Upload e listagem do import de reviews (docs/REVIEWS-IMPORT.md). Camada
// unica de I/O do lado "aquisicao": rota fina -> este servico -> libs puras
// de lib/reviews. Dependencias injetaveis para os testes rodarem sem banco.
//
// Autorizacao: o gate mora no router (isReviewsUser, 409 fora da allowlist) e
// o modelo e COMPARTILHADO de proposito — arquivo importado nao tem dono,
// qualquer operador da allowlist ve/sincroniza/copia erros de todos (uploadedBy
// e auditoria, nao posse). Nao adicionar escopo por usuario aqui.

const crypto = require('crypto');
const { parseReviewRows, reviewRowHash, chunkRows } = require('../../lib/reviews/reviewRows');
const { ReviewsServiceError } = require('./errors');

const FEED = 'magento-reviews';
const INVALID_SAMPLE_LIMIT = 200;
const ERROR_SAMPLE_LIMIT = 10;

// Chave do staging no Spaces: prefixo proprio review-imports/ (fora de
// feeds/, entao o feed-prune nunca o toca). O objeto vive so durante o
// import: apagado quando o arquivo fecha ready.
const stagingKey = ({ fileName, sha256, at }) => {
	const iso = at.toISOString();
	const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return `review-imports/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${stamp}-${sha256.slice(0, 8)}-${fileName}`;
};

function createReviewImportService({
	prisma,
	config,
	parseWorkbookBuffer,
	store = null,
	logger = console,
	now = () => new Date(),
} = {}) {
	// Um parse por vez no processo: o XLSX infla em memoria (container de 2GB)
	// e o operador nao precisa de paralelismo aqui.
	let parsing = false;

	async function uploadFile({ user, file }) {
		const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
		const existing = await prisma.reviewImportFile.findUnique({ where: { sha256 } });
		if (existing && existing.status === 'ready') {
			throw ReviewsServiceError.conflict(
				'DUPLICATE_FILE',
				`This exact file was already imported by ${existing.uploadedBy} (file #${existing.id})`
			);
		}
		if (parsing) {
			throw ReviewsServiceError.conflict('PARSE_BUSY', 'Another spreadsheet is being processed — try again in a moment');
		}
		parsing = true;
		try {
			let rows;
			try {
				rows = parseWorkbookBuffer(file.buffer, file.originalname, { maxRows: config.maxRows });
			} catch (error) {
				throw ReviewsServiceError.validation(`Could not read the spreadsheet: ${String(error.message).slice(0, 200)}`);
			}
			let parsed;
			try {
				parsed = parseReviewRows(rows);
			} catch (error) {
				throw ReviewsServiceError.validation(String(error.message).slice(0, 200));
			}
			const { valid, invalid } = parsed;
			if (valid.length === 0) {
				throw ReviewsServiceError.validation(
					`No valid review rows found (${invalid.length} invalid row(s))${invalid[0] ? ` — first error: row ${invalid[0].rowNumber}: ${invalid[0].error}` : ''}`
				);
			}

			// Retomada de upload: morreu no meio da insercao, o arquivo ficou
			// 'importing'; re-upload do MESMO sha continua daqui (skipDuplicates
			// torna a re-insercao idempotente).
			let fileRecord = existing;
			if (!fileRecord) {
				try {
					fileRecord = await prisma.reviewImportFile.create({
						data: {
							fileName: String(file.originalname || 'reviews.xlsx').slice(0, 255),
							sha256,
							sizeBytes: file.size,
							uploadedBy: user.username, // sempre do JWT, nunca do form
							rowCount: valid.length + invalid.length,
							invalidRowCount: invalid.length,
							invalidSample: invalid.slice(0, INVALID_SAMPLE_LIMIT),
						},
					});
				} catch (error) {
					// Corrida de uploads simultaneos: a UNIQUE do banco decide.
					if (error.code === 'P2002') {
						throw ReviewsServiceError.conflict('DUPLICATE_FILE', 'This exact file is already being imported');
					}
					throw error;
				}
			}

			// Staging no Spaces ANTES de inserir as linhas: se a insercao morrer,
			// o original esta salvo no bucket. Best-effort de proposito — Spaces
			// fora do ar nao pode bloquear o import (as linhas no banco sao a
			// fonte de verdade); sem sucesso, objectKey fica null.
			if (store?.isConfigured() && !fileRecord.objectKey) {
				const key = stagingKey({ fileName: fileRecord.fileName, sha256, at: now() });
				try {
					await store.putStream({
						key,
						body: file.buffer,
						contentLength: file.size,
						contentType: 'application/octet-stream',
					});
					fileRecord = await prisma.reviewImportFile.update({
						where: { id: fileRecord.id },
						data: { objectKey: key },
					});
				} catch (error) {
					logger.warn?.(`reviews staging upload to Spaces failed (import continues): ${String(error.message).slice(0, 120)}`);
				}
			}

			let insertedCount = 0;
			for (const chunk of chunkRows(valid, config.insertChunkSize)) {
				const result = await prisma.reviewImportRow.createMany({
					data: chunk.map((row) => ({
						fileId: fileRecord.id,
						rowNumber: row.rowNumber,
						sku: row.sku,
						nickname: row.nickname,
						summary: row.summary,
						text: row.text,
						ratingValue: row.ratingValue,
						reviewDate: row.reviewDate,
						rowHash: reviewRowHash(row),
					})),
					skipDuplicates: true,
				});
				insertedCount += result.count;
			}

			const duplicateRowCount = valid.length - insertedCount;
			// Import fechado: as linhas no banco sao a fonte de verdade — o
			// arquivo pode sair do Spaces (pedido do usuario). Falha no delete
			// nao quebra o import: objectKey fica para uma limpeza posterior.
			let clearedObjectKey = fileRecord.objectKey || null;
			if (fileRecord.objectKey && store?.isConfigured()) {
				try {
					await store.deleteObject(fileRecord.objectKey);
					clearedObjectKey = null;
				} catch (error) {
					logger.warn?.(`reviews staging cleanup failed (kept ${fileRecord.objectKey}): ${String(error.message).slice(0, 120)}`);
				}
			}
			const updated = await prisma.reviewImportFile.update({
				where: { id: fileRecord.id },
				data: { status: 'ready', duplicateRowCount, objectKey: clearedObjectKey },
			});
			return {
				file: updated,
				counts: { rows: valid.length + invalid.length, inserted: insertedCount, duplicates: duplicateRowCount, invalid: invalid.length },
			};
		} finally {
			parsing = false;
		}
	}

	async function listFiles() {
		const files = await prisma.reviewImportFile.findMany({ orderBy: { id: 'desc' }, take: 50 });
		const fileIds = files.map((file) => file.id);
		const grouped = fileIds.length
			? await prisma.reviewImportRow.groupBy({
				by: ['fileId', 'status'],
				where: { fileId: { in: fileIds } },
				_count: { _all: true },
			})
			: [];
		const countsFor = (fileId) => {
			const counts = { pending: 0, sending: 0, synced: 0, failed: 0 };
			for (const entry of grouped) {
				if (entry.fileId === fileId) counts[entry.status] = entry._count._all;
			}
			return counts;
		};

		const withCounts = [];
		for (const file of files) {
			const counts = countsFor(file.id);
			let errorSamples = [];
			if (counts.failed > 0) {
				errorSamples = await prisma.reviewImportRow.findMany({
					where: { fileId: file.id, status: 'failed' },
					orderBy: { id: 'asc' },
					take: ERROR_SAMPLE_LIMIT,
					select: { rowNumber: true, sku: true, error: true },
				});
			}
			withCounts.push({ ...file, counts, errorSamples });
		}

		const lastRun = await prisma.ingestRun.findFirst({ where: { feed: FEED }, orderBy: { id: 'desc' } });
		return {
			files: withCounts,
			lastRun,
			running: lastRun?.status === 'running',
			generatedAt: now().toISOString(),
		};
	}

	// Todos os erros de um arquivo, para o botao "Copy errors" do painel:
	// linhas failed completas (nao a amostra de 10) + as invalidas do parse.
	async function getFileErrors(fileId) {
		const file = await prisma.reviewImportFile.findUnique({ where: { id: fileId } });
		if (!file) throw ReviewsServiceError.notFound();
		const failed = await prisma.reviewImportRow.findMany({
			where: { fileId, status: 'failed' },
			orderBy: { rowNumber: 'asc' },
			take: 1000,
			select: { rowNumber: true, sku: true, nickname: true, error: true },
		});
		return {
			fileName: file.fileName,
			failed,
			invalidSample: Array.isArray(file.invalidSample) ? file.invalidSample : [],
			invalidRowCount: file.invalidRowCount,
		};
	}

	return { uploadFile, listFiles, getFileErrors };
}

module.exports = { createReviewImportService, FEED };
