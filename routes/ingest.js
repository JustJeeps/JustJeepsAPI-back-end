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
const upload = multer({
	storage: multer.diskStorage({ destination: os.tmpdir() }),
	limits: { fileSize: feedsConfig.config.uploadPanelMaxBytes, files: 5 },
});

// BigInt (sizeBytes) nao serializa em JSON.
const serializeArtifact = (artifact) => ({ ...artifact, sizeBytes: Number(artifact.sizeBytes) });

const runningFeed = (feed) => runner.getStatus(feed)?.status === 'running';

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
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error('Ingest feeds route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.get('/runs', async (req, res) => {
	try {
		const limit = Math.min(Number(req.query.limit) || 50, 200);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const { runs, total } = await catalog.listRuns(prisma, {
			feed: req.query.feed || undefined,
			status: req.query.status || undefined,
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
router.post('/feeds/:feed/upload', upload.array('files', 5), async (req, res) => {
	const tmpFiles = (req.files || []).map((file) => file.path);
	const cleanup = () => tmpFiles.forEach((tmpPath) => fs.rmSync(tmpPath, { force: true }));

	try {
		if (!isTriageUser(req.user.username)) {
			return res.status(409).json({ error: 'Only triage users can upload feeds', code: 'TRIAGE_ONLY' });
		}

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
router.post('/feeds/:feed/run', (req, res) => {
	try {
		if (!isTriageUser(req.user.username)) {
			return res.status(409).json({ error: 'Only triage users can run feed scripts', code: 'TRIAGE_ONLY' });
		}
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

router.get('/feeds/:feed/run-status', (req, res) => {
	const status = runner.getStatus(req.params.feed);
	if (!status) return res.status(404).json({ error: 'No run for this feed in the current server session' });
	res.json(status);
});

module.exports = router;
