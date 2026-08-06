// Rotas HTTP dos feeds de vendor (catalogo + auditoria de ingest). Camada
// fina sobre lib/feeds/catalog. Regra de negocio violada responde 409 (nunca
// 403 — o interceptor do front desloga o usuario em 403 de auth), mesmo
// contrato de routes/requests.js.

const os = require('os');
const fs = require('fs');
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
