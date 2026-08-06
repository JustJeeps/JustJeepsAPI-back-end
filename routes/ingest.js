// Rotas HTTP dos feeds de vendor (catalogo + auditoria de ingest). Camada
// fina sobre lib/feeds/catalog. Regra de negocio violada responde 409 (nunca
// 403 — o interceptor do front desloga o usuario em 403 de auth), mesmo
// contrato de routes/requests.js.

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');

const prisma = require('../lib/prisma');
const catalog = require('../lib/feeds/catalog');
const feedsConfig = require('../config/feeds');
const { createFeedStore } = require('../lib/feeds/feedStore');
const runner = require('../services/feeds/runnerInstance');
const { hashFile } = require('../lib/ingest/fileHash');
const { isTriageUser } = require('../config/triage');

const router = express.Router();
const store = createFeedStore();

const CONTENT_TYPES = {
	'.csv': 'text/csv',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
};

// Upload em disco (tmp): planilhas de feed chegam a 34MB — nunca em memoria.
// Limites de partes tambem sao explicitos: sem eles multer aceita infinitos
// campos nao-arquivo, todos bufferizados antes do handler rodar.
const upload = multer({
	storage: multer.diskStorage({ destination: os.tmpdir() }),
	limits: {
		fileSize: feedsConfig.config.uploadPanelMaxBytes,
		files: 5,
		fields: 4,
		parts: 12,
		fieldSize: 4096,
	},
});

// Triage antes de QUALQUER escrita. Como middleware (e nao dentro do handler),
// roda ANTES do multer: sem isso qualquer usuario autenticado despejava ate
// 500MB no disco do container e so depois levava 409.
const requireTriage = (req, res, next) => {
	if (!isTriageUser(req.user.username)) {
		return res.status(409).json({ error: 'Only triage users can manage feeds', code: 'TRIAGE_ONLY' });
	}
	next();
};

// BigInt (sizeBytes) nao serializa em JSON.
const serializeArtifact = (artifact) => ({ ...artifact, sizeBytes: Number(artifact.sizeBytes) });

const runningFeed = (feed) => runner.getStatus(feed)?.status === 'running';

// Partes de 8MB: acima do minimo de 5MB do S3 e pequeno o bastante para o
// reenvio de uma parte perdida ser barato numa conexao ruim.
const MULTIPART_PART_SIZE_BYTES = Number(process.env.FEED_MULTIPART_PART_SIZE_BYTES || 8 * 1024 * 1024);

const RUN_STATUSES = ['running', 'success', 'failed', 'skipped-unchanged', 'skipped-locked'];

// Nunca devolver linha que pareca credencial (seed que loga header de auth,
// connection string do Prisma num erro, etc.).
const SECRET_LINE = /(password|passwd|secret|token|api[-_ ]?key|authorization|bearer\s|postgres(ql)?:\/\/|amqp:\/\/)/i;
const redactLogTail = (tail) => String(tail || '')
	.split('\n')
	.map((line) => (SECRET_LINE.test(line) ? '[line redacted: possible credential]' : line))
	.join('\n');

const serializeStatus = (status) => ({
	...status,
	// Botao "Run now" do painel: so aparece para feed com script proprio.
	seedCommand: status.seedCommand,
	seedCommandNote: status.seedCommandNote,
	running: runningFeed(status.feed),
	ageHours: status.ageHours === null ? null : Number(status.ageHours.toFixed(1)),
	currentBatch: status.currentBatch
		? { ...status.currentBatch, artifacts: status.currentBatch.artifacts.map(serializeArtifact) }
		: null,
});

// --- guard: feature exige usuario logado (mesmo contrato de requests) ----------
router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({
			error: 'Access token required',
			message: 'The feeds feature requires authentication (ENABLE_AUTH=true)',
		});
	}
	next();
});

router.get('/feeds', async (req, res) => {
	try {
		const statuses = await catalog.listFeedStatuses(prisma, feedsConfig.getFeedDefinitions());
		res.json({
			feeds: statuses.map(serializeStatus),
			storeConfigured: store.isConfigured(),
			// Quem pode subir arquivo e disparar script. Qualquer usuario logado
			// LE o painel (frescor dos feeds e informacao util para todos); so
			// triage escreve. O painel usa isto para habilitar os botoes — a
			// validacao real continua em cada rota de escrita.
			canManage: isTriageUser(req.user.username),
			// O painel usa isto para decidir entre o upload direto ao bucket
			// (multipart assinado) e o upload legado via API.
			directUpload: { enabled: store.isConfigured(), partSizeBytes: MULTIPART_PART_SIZE_BYTES },
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error('Ingest feeds route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.get('/runs', requireTriage, async (req, res) => {
	try {
		// Express usa o parser "extended": ?feed[contains]=x chega como OBJETO e
		// iria direto para o where do Prisma. String() + allowlist fecham isso.
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const feedParam = req.query.feed === undefined ? undefined : String(req.query.feed);
		const statusParam = req.query.status === undefined ? undefined : String(req.query.status);
		if (statusParam !== undefined && !RUN_STATUSES.includes(statusParam)) {
			return res.status(400).json({ error: `Invalid status. Allowed: ${RUN_STATUSES.join(', ')}` });
		}
		const { runs, total } = await catalog.listRuns(prisma, {
			feed: feedParam,
			status: statusParam,
			limit,
			offset,
		});
		res.json({ runs, total, limit, offset });
	} catch (error) {
		console.error('Ingest runs route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// --- upload direto para o bucket (multipart + URL assinada) -----------------
//
// Por que existe: no upload que passa pela API o arquivo inteiro vai para o
// disco do container (1 vCPU / 2GB) antes de chegar ao bucket. Aqui o navegador
// fala direto com o Spaces e a API so autoriza e cataloga. De quebra, upload em
// partes retoma so o pedaco que faltou quando a rede cai.
//
// Limites que a API impoe (o navegador NAO escolhe nada disso):
//   - a key e montada no servidor a partir do feed e do nome canonico;
//   - o arquivo precisa ser um dos esperados pelo feed;
//   - o tamanho declarado precisa caber no limite do feed;
//   - o tamanho catalogado e o do bucket (HeadObject), nao o que o cliente diz.

// Sessoes de upload em andamento: uploadId -> contexto validado no init.
// Em memoria de proposito — um restart invalida sessoes pendentes, que o
// proprio Spaces expira depois (nao ha estado que valha persistir).
const uploadSessions = new Map();
const UPLOAD_SESSION_TTL_MS = Number(process.env.FEED_UPLOAD_SESSION_TTL_MS || 60 * 60 * 1000);

const pruneSessions = () => {
	const now = Date.now();
	for (const [id, session] of uploadSessions) {
		if (now - session.createdAt > UPLOAD_SESSION_TTL_MS) uploadSessions.delete(id);
	}
};

const resolveFeedAndFile = (req, res) => {
	const feed = feedsConfig.getFeedByName(req.params.feed);
	if (!feed) {
		res.status(404).json({ error: `Unknown feed: ${req.params.feed}` });
		return null;
	}
	if (!store.isConfigured()) {
		res.status(409).json({ error: 'Feed storage is not configured (DO_SPACES_*)', code: 'FEEDS_DISABLED' });
		return null;
	}
	return feed;
};

// 0) Ja temos este conteudo? O navegador manda o sha256 do arquivo ANTES de
// enviar um byte. Se o hash ja existe para (feed, arquivo), nao ha o que subir:
// o objeto no bucket e imutavel e identificado pelo conteudo. Isso evita
// reenviar 460MB so porque alguem clicou de novo no mesmo arquivo.
router.post('/feeds/:feed/uploads/check', requireTriage, async (req, res) => {
	try {
		const feed = resolveFeedAndFile(req, res);
		if (!feed) return undefined;

		const fileName = String(req.body?.fileName || '');
		const sha256 = String(req.body?.sha256 || '');
		if (!feed.files.includes(fileName)) {
			return res.status(409).json({ error: `Unexpected file for feed ${feed.name}: ${fileName}`, code: 'FEED_FILE_MISMATCH' });
		}
		if (!/^[a-f0-9]{64}$/i.test(sha256)) {
			return res.status(400).json({ error: 'sha256 is required' });
		}

		const existing = await catalog.findArtifactByHash(prisma, feed.name, fileName, sha256);
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		const isCurrent = Boolean(
			existing && current?.artifacts.some((artifact) => artifact.id === existing.id)
		);

		res.json({
			duplicate: Boolean(existing),
			isCurrent,
			artifact: existing ? serializeArtifact(existing) : null,
		});
	} catch (error) {
		console.error('Ingest upload check error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// 0b) Conteudo repetido, mas de um lote antigo: cataloga um artefato novo
// apontando para o objeto que JA esta no bucket — zero bytes trafegados. Serve
// tambem para completar um lote onde so um dos arquivos mudou.
router.post('/feeds/:feed/uploads/reuse', requireTriage, async (req, res) => {
	try {
		const feed = resolveFeedAndFile(req, res);
		if (!feed) return undefined;

		const fileName = String(req.body?.fileName || '');
		const sha256 = String(req.body?.sha256 || '');
		const existing = await catalog.findArtifactByHash(prisma, feed.name, fileName, sha256);
		if (!existing) {
			return res.status(404).json({ error: 'No catalogued file with this content', code: 'FEED_HASH_UNKNOWN' });
		}

		const { batchId, artifacts } = await catalog.registerArtifacts(prisma, {
			feed: feed.name,
			batchId: req.body?.batchId || undefined,
			source: 'manual',
			uploadedBy: req.user.username,
			note: req.body?.note ? String(req.body.note).slice(0, 2000) : 'reused: identical content already in storage',
			files: [{
				fileName: existing.fileName,
				objectKey: existing.objectKey,
				sha256: existing.sha256,
				sizeBytes: Number(existing.sizeBytes),
				contentType: existing.contentType,
			}],
		});

		res.status(201).json({ batchId, artifacts: artifacts.map(serializeArtifact), reused: true });
	} catch (error) {
		console.error('Ingest upload reuse error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// 1) Abre a sessao: valida feed/arquivo/tamanho e devolve uploadId + key.
router.post('/feeds/:feed/uploads', requireTriage, async (req, res) => {
	try {
		const feed = resolveFeedAndFile(req, res);
		if (!feed) return undefined;

		const fileName = String(req.body?.fileName || '');
		const sizeBytes = Number(req.body?.sizeBytes || 0);

		if (!feed.files.includes(fileName)) {
			return res.status(409).json({
				error: `Unexpected file for feed ${feed.name}: ${fileName}. Expected: ${feed.files.join(', ')}`,
				code: 'FEED_FILE_MISMATCH',
			});
		}
		if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
			return res.status(400).json({ error: 'sizeBytes is required' });
		}
		if (sizeBytes > feed.maxUploadBytes) {
			return res.status(409).json({
				error: `File too large for ${feed.name} (max ${Math.round(feed.maxUploadBytes / 1024 / 1024)}MB)`,
				code: 'FEED_FILE_TOO_LARGE',
			});
		}

		// A key sai daqui: o cliente nunca escolhe caminho no bucket. O sha8 real
		// so e conhecido no fim, entao a key usa um token aleatorio e o hash vai
		// para o catalogo (a key permanece unica e imutavel de qualquer forma).
		const key = store.buildKey({
			feed: feed.name,
			fileName,
			sha256: crypto.randomBytes(16).toString('hex'),
		});
		const contentType = CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
		const { uploadId } = await store.createMultipartUpload({ key, contentType });

		pruneSessions();
		uploadSessions.set(uploadId, {
			feed: feed.name,
			fileName,
			key,
			contentType,
			sizeBytes,
			createdAt: Date.now(),
			startedBy: req.user.username,
		});

		res.status(201).json({ uploadId, key, partSizeBytes: MULTIPART_PART_SIZE_BYTES });
	} catch (error) {
		console.error('Ingest upload init error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// 2) Assina UMA parte. A assinatura vale so para esta key/uploadId/parte.
router.post('/feeds/:feed/uploads/:uploadId/part', requireTriage, async (req, res) => {
	try {
		const session = uploadSessions.get(req.params.uploadId);
		if (!session || session.feed !== req.params.feed) {
			return res.status(404).json({ error: 'Upload session not found or expired', code: 'UPLOAD_SESSION_GONE' });
		}
		const partNumber = Number(req.body?.partNumber);
		if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
			return res.status(400).json({ error: 'partNumber must be between 1 and 10000' });
		}
		const url = await store.signUploadPart({ key: session.key, uploadId: req.params.uploadId, partNumber });
		res.json({ url });
	} catch (error) {
		console.error('Ingest upload sign error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// 3) Fecha o multipart e cataloga. O sha256 e o tamanho vem do BUCKET.
router.post('/feeds/:feed/uploads/:uploadId/complete', requireTriage, async (req, res) => {
	const session = uploadSessions.get(req.params.uploadId);
	try {
		if (!session || session.feed !== req.params.feed) {
			return res.status(404).json({ error: 'Upload session not found or expired', code: 'UPLOAD_SESSION_GONE' });
		}
		// As partes vem do BUCKET, nao do cliente: ler o ETag no navegador exige
		// ExposeHeaders no CORS (campo que o painel do Spaces nao tem) e, de
		// qualquer forma, quem sabe o que foi realmente gravado e o storage.
		const parts = await store.listParts({ key: session.key, uploadId: req.params.uploadId });
		if (parts.length === 0) {
			return res.status(409).json({ error: 'No uploaded parts found for this upload', code: 'UPLOAD_EMPTY' });
		}
		const sha256 = String(req.body?.sha256 || '');
		if (!/^[a-f0-9]{64}$/i.test(sha256)) {
			return res.status(400).json({ error: 'sha256 of the uploaded file is required' });
		}

		await store.completeMultipartUpload({ key: session.key, uploadId: req.params.uploadId, parts });
		const head = await store.headObject(session.key);

		const feed = feedsConfig.getFeedByName(session.feed);
		// O tamanho declarado na abertura nao vincula os bytes: a assinatura de
		// cada parte nao limita content-length. Entao o limite do feed e aplicado
		// aqui, sobre o tamanho REAL gravado, e o objeto que estourou some — nao
		// fica ocupando espaco nem entra no catalogo.
		if (Number(head.sizeBytes) > feed.maxUploadBytes) {
			await store.deleteObject(session.key).catch(() => {});
			uploadSessions.delete(req.params.uploadId);
			return res.status(409).json({
				error: `Uploaded file is larger than allowed for ${feed.name} (${Math.round(head.sizeBytes / 1024 / 1024)}MB > ${Math.round(feed.maxUploadBytes / 1024 / 1024)}MB)`,
				code: 'FEED_FILE_TOO_LARGE',
			});
		}
		const { batchId, artifacts } = await catalog.registerArtifacts(prisma, {
			feed: feed.name,
			batchId: req.body?.batchId || undefined,
			source: 'manual',
			uploadedBy: session.startedBy,
			note: req.body?.note ? String(req.body.note).slice(0, 2000) : null,
			files: [{
				fileName: session.fileName,
				objectKey: session.key,
				sha256,
				sizeBytes: head.sizeBytes,
				contentType: session.contentType,
			}],
		});

		uploadSessions.delete(req.params.uploadId);
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		res.status(201).json({
			batchId,
			artifacts: artifacts.map(serializeArtifact),
			isCurrent: current?.batchId === batchId,
			missingFiles: feed.files.filter((name) => name !== session.fileName && !(current?.artifacts || []).some((a) => a.fileName === name)),
		});
	} catch (error) {
		console.error('Ingest upload complete error:', error);
		if (session) {
			await store.abortMultipartUpload({ key: session.key, uploadId: req.params.uploadId }).catch(() => {});
			uploadSessions.delete(req.params.uploadId);
		}
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Cancelamento explicito (usuario fechou a janela no meio): sem isso as partes
// ficam ocupando espaco no bucket ate a politica de lifecycle limpar.
router.delete('/feeds/:feed/uploads/:uploadId', requireTriage, async (req, res) => {
	const session = uploadSessions.get(req.params.uploadId);
	if (!session || session.feed !== req.params.feed) return res.status(204).end();
	await store.abortMultipartUpload({ key: session.key, uploadId: req.params.uploadId }).catch(() => {});
	uploadSessions.delete(req.params.uploadId);
	res.status(204).end();
});

// Upload manual via painel: exige triage e o conjunto COMPLETO de arquivos do
// feed numa request so (lote parcial nunca vira corrente — a CLI cobre o caso
// avancado de completar lote com --batch).
router.post('/feeds/:feed/upload', requireTriage, upload.array('files', 5), async (req, res) => {
	const tmpFiles = (req.files || []).map((file) => file.path);
	const cleanup = () => tmpFiles.forEach((tmpPath) => fs.rmSync(tmpPath, { force: true }));

	try {
		const feed = feedsConfig.getFeedByName(req.params.feed);
		if (!feed) {
			return res.status(404).json({ error: `Unknown feed: ${req.params.feed}` });
		}
		if (!store.isConfigured()) {
			return res.status(409).json({
				error: 'Feed storage is not configured (DO_SPACES_*)',
				code: 'FEEDS_DISABLED',
			});
		}

		const incoming = (req.files || []).map((file) => ({
			tmpPath: file.path,
			// Multer decodifica filename como latin1 — mesmo fix de routes/requests.js.
			fileName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
			sizeBytes: file.size,
		}));

		const names = incoming.map((file) => file.fileName);
		const unexpected = names.filter((name) => !feed.files.includes(name));
		if (unexpected.length > 0) {
			return res.status(409).json({
				error: `Unexpected file(s) for feed ${feed.name}: ${unexpected.join(', ')}. Expected: ${feed.files.join(', ')}`,
				code: 'FEED_FILE_MISMATCH',
			});
		}
		const missing = feed.files.filter((name) => !names.includes(name));
		if (missing.length > 0) {
			return res.status(409).json({
				error: `Feed ${feed.name} requires all files in one upload. Missing: ${missing.join(', ')}`,
				code: 'FEED_BATCH_INCOMPLETE',
			});
		}
		const oversized = incoming.filter((file) => file.sizeBytes > feed.maxUploadBytes);
		if (oversized.length > 0) {
			return res.status(409).json({
				error: `File too large for panel upload (max ${Math.round(feed.maxUploadBytes / 1024 / 1024)}MB): ${oversized.map((f) => f.fileName).join(', ')}. Use the CLI (npm run feed-upload).`,
				code: 'FEED_FILE_TOO_LARGE',
			});
		}

		const files = [];
		for (const file of incoming) {
			const sha256 = await hashFile(file.tmpPath);
			const key = store.buildKey({ feed: feed.name, fileName: file.fileName, sha256 });
			await store.putFile({
				key,
				filePath: file.tmpPath,
				contentType: CONTENT_TYPES[path.extname(file.fileName).toLowerCase()] || 'application/octet-stream',
				sizeBytes: file.sizeBytes,
			});
			files.push({ fileName: file.fileName, objectKey: key, sha256, sizeBytes: file.sizeBytes, contentType: CONTENT_TYPES[path.extname(file.fileName).toLowerCase()] || null });
		}

		const { batchId, artifacts } = await catalog.registerArtifacts(prisma, {
			feed: feed.name,
			source: 'manual',
			uploadedBy: req.user.username,
			note: req.body.note ? String(req.body.note).slice(0, 2000) : null,
			files,
		});

		res.status(201).json({ batchId, artifacts: artifacts.map(serializeArtifact) });
	} catch (error) {
		console.error('Ingest upload route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	} finally {
		cleanup();
	}
});

// "Run now": roda o script daquele feed no servidor para conferir o arquivo
// recem subido sem esperar o seed-all. Assincrono — o painel acompanha por
// GET .../run-status. Triage only (o script escreve em VendorProduct de prod).
router.post('/feeds/:feed/run', requireTriage, (req, res) => {
	try {
		const record = runner.start(req.params.feed, { startedBy: req.user.username });
		res.status(202).json(record);
	} catch (error) {
		if (error.code === 'FEED_UNKNOWN') {
			return res.status(404).json({ error: error.message, code: error.code });
		}
		if (error.code === 'FEED_RUN_NOT_ALLOWED' || error.code === 'FEED_RUN_BUSY') {
			return res.status(409).json({ error: error.message, code: error.code });
		}
		console.error('Ingest run route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.get('/feeds/:feed/run-status', requireTriage, (req, res) => {
	const status = runner.getStatus(String(req.params.feed));
	if (!status) return res.status(404).json({ error: 'No run for this feed in the current server session' });
	// logFile e caminho interno do container; o log tail traz saida crua de seed
	// (que um script futuro pode imprimir com header de auth): redigido.
	const { logFile, ...safe } = status;
	res.json({ ...safe, logTail: redactLogTail(status.logTail) });
});

module.exports = router;
