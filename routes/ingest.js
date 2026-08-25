// HTTP routes for the vendor feeds (catalog + ingest audit trail). Thin layer
// on top of lib/feeds/catalog. A violated business rule answers 409 (never
// 403: the front-end interceptor logs the user out on an auth 403), same
// contract as routes/requests.js.

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
const { isReviewsUser } = require('../config/reviews');

const router = express.Router();
const store = createFeedStore();

const CONTENT_TYPES = {
	'.csv': 'text/csv',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
};

// Upload to disk (tmp): feed spreadsheets reach 34MB, never keep them in
// memory. The part limits are explicit too: without them multer accepts an
// unlimited number of non-file fields, all buffered before the handler runs.
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

// Triage before ANY write. As middleware (and not inside the handler) it runs
// BEFORE multer: without this any authenticated user could dump up to 500MB on
// the container disk and only then get a 409.
const requireTriage = (req, res, next) => {
	if (!isTriageUser(req.user.username)) {
		return res.status(409).json({ error: 'Only triage users can manage feeds', code: 'TRIAGE_ONLY' });
	}
	next();
};

// BigInt (sizeBytes) does not serialize to JSON.
const serializeArtifact = (artifact) => ({ ...artifact, sizeBytes: Number(artifact.sizeBytes) });

const runningFeed = (feed) => runner.getRun(feed)?.status === 'running';

// 8MB parts: above the 5MB S3 minimum and small enough that resending a lost
// part stays cheap on a bad connection.
const MULTIPART_PART_SIZE_BYTES = Number(process.env.FEED_MULTIPART_PART_SIZE_BYTES || 8 * 1024 * 1024);

const RUN_STATUSES = ['running', 'success', 'failed', 'skipped-unchanged', 'skipped-locked'];

// Never return a line that looks like a credential (a seed logging an auth
// header, a Prisma connection string inside an error, etc.).
const SECRET_LINE = /(password|passwd|secret|token|api[-_ ]?key|authorization|bearer\s|postgres(ql)?:\/\/|amqp:\/\/)/i;
const redactLogTail = (tail) => String(tail || '')
	.split('\n')
	.map((line) => (SECRET_LINE.test(line) ? '[line redacted: possible credential]' : line))
	.join('\n');

const serializeStatus = (status) => ({
	...status,
	// Panel "Run now" button: only shows up for a feed with its own script.
	seedCommand: status.seedCommand,
	seedCommandNote: status.seedCommandNote,
	fetchCommand: status.fetchCommand,
	running: runningFeed(status.feed),
	ageHours: status.ageHours === null ? null : Number(status.ageHours.toFixed(1)),
	currentBatch: status.currentBatch
		? { ...status.currentBatch, artifacts: status.currentBatch.artifacts.map(serializeArtifact) }
		: null,
});

// --- guard: feature requires a logged in user (same contract as requests) ------
router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({
			error: 'Access token required',
			message: 'The feeds feature requires authentication (ENABLE_AUTH=true)',
		});
	}
	next();
});

// Feeds carrying personal or financial data (the QuickBooks export) are only
// listed for the people who can act on them. Uploading and running were
// already triage only; this keeps the metadata (file names, sizes, who
// uploaded and when) out of the panel for everyone else.
const visibleFeedsFor = (username) => {
	const canManage = isTriageUser(username);
	return feedsConfig.getFeedDefinitions().filter((feed) => canManage || !feed.restricted);
};

router.get('/feeds', async (req, res) => {
	try {
		const statuses = await catalog.listFeedStatuses(prisma, visibleFeedsFor(req.user.username));
		res.json({
			feeds: statuses.map(serializeStatus),
			storeConfigured: store.isConfigured(),
			// Who can upload a file and trigger a script. Any logged in user can
			// READ the panel (feed freshness is useful information for everyone);
			// only triage writes. The panel uses this to enable the buttons, the
			// real validation still happens in every write route.
			canManage: isTriageUser(req.user.username),
			// The panel can only disable the button correctly if it knows what is
			// holding the slot: another feed, or the daily sync.
			busy: {
				feed: runner.busyFeed(),
				dailySync: runner.isDailySyncRunning(),
			},
			// The panel uses this to choose between the direct upload to the
			// bucket (signed multipart) and the legacy upload through the API.
			// apiFallbackMaxBytes: ceiling of the LEGACY path only (multer/disk);
			// the signed path is bounded by each feed's own maxUploadBytes.
			directUpload: {
				enabled: store.isConfigured(),
				partSizeBytes: MULTIPART_PART_SIZE_BYTES,
				apiFallbackMaxBytes: feedsConfig.config.uploadPanelMaxBytes,
			},
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error('Ingest feeds route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Reading the history is allowed for any signed-in user, like the feed list
// itself: the raw script log (run-status) and every write stay triage-only.
router.get('/runs', async (req, res) => {
	try {
		// Express uses the "extended" parser: ?feed[contains]=x arrives as an
		// OBJECT and would go straight into the Prisma where clause. String()
		// plus an allowlist close that off.
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const feedParam = req.query.feed === undefined ? undefined : String(req.query.feed);
		const statusParam = req.query.status === undefined ? undefined : String(req.query.status);
		if (statusParam !== undefined && !RUN_STATUSES.includes(statusParam)) {
			return res.status(400).json({ error: `Invalid status. Allowed: ${RUN_STATUSES.join(', ')}` });
		}
		// Same rule as the listing: a restricted feed's runs are triage only, and
		// asking for one by name from outside triage answers an empty page rather
		// than confirming it exists.
		const visibleFeeds = visibleFeedsFor(req.user.username);
		const hiddenFeeds = feedsConfig.getFeedDefinitions()
			.filter((feed) => !visibleFeeds.some((visible) => visible.name === feed.name))
			.flatMap((feed) => [feed.name, feed.ingestFeed, `${feed.name}-fetch`]);
		// magento-reviews vive fora do registry de feeds (e um job, nao um
		// snapshot) — sem esta linha, qualquer logado leria os runs do sync de
		// reviews por aqui. Mesmo contrato dos restritos: pagina vazia.
		if (!isReviewsUser(req.user.username)) hiddenFeeds.push('magento-reviews');
		if (feedParam !== undefined && hiddenFeeds.includes(feedParam)) {
			return res.json({ runs: [], total: 0, limit, offset });
		}

		const { runs, total } = await catalog.listRuns(prisma, {
			feed: feedParam,
			excludeFeeds: hiddenFeeds,
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

// --- direct upload to the bucket (multipart + signed URL) -------------------
//
// Why it exists: on the upload that goes through the API the whole file lands
// on the container disk (1 vCPU / 2GB) before reaching the bucket. Here the
// browser talks straight to Spaces and the API only authorizes and catalogues.
// As a bonus, a multipart upload resends only the missing chunk when the
// network drops.
//
// Limits the API enforces (the browser does NOT choose any of this):
//   - the key is built on the server from the feed and the canonical name;
//   - the file has to be one of the files the feed expects;
//   - the declared size has to fit inside the feed limit;
//   - the catalogued size comes from the bucket (HeadObject), not from what
//     the client claims.

// Uploads in flight: uploadId -> context validated at init time.
// In memory on purpose: a restart invalidates pending sessions, which Spaces
// itself expires later (there is no state worth persisting).
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

// 0) Do we already have this content? The browser sends the sha256 of the file
// BEFORE uploading a single byte. If the hash already exists for (feed, file),
// there is nothing to upload: the object in the bucket is immutable and
// identified by its content. This avoids resending 460MB just because someone
// picked the same file again.
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

// 1) Opens the session: validates feed/file/size and returns uploadId + key.
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

		// The key is built here: the client never chooses a path in the bucket.
		// The real sha8 is only known at the end, so the key uses a random token
		// and the hash goes to the catalog (the key stays unique and immutable
		// either way).
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

// 2) Signs ONE part. The signature is only valid for this key/uploadId/part.
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

// 3) Closes the multipart upload and catalogues it. The sha256 and the size
// come from the BUCKET.
// 3) Finishes the multipart of ONE file. It does NOT catalog: the whole set is
// registered by the commit below. Registering file by file superseded the
// previous artifact of each name, so between the first and the last file no
// batch covered every file, the feed read "no data" on screen, and the next
// feed-sync removed the symlinks and broke that night's vendor scripts.
router.post('/feeds/:feed/uploads/:uploadId/complete', requireTriage, async (req, res) => {
	const session = uploadSessions.get(req.params.uploadId);
	try {
		if (!session || session.feed !== req.params.feed) {
			return res.status(404).json({ error: 'Upload session not found or expired', code: 'UPLOAD_SESSION_GONE' });
		}
		// The parts come from the BUCKET, not from the client: reading the ETag in
		// the browser requires ExposeHeaders in the CORS config (a field the Spaces
		// panel does not have) and, either way, the storage is what knows what was
		// really written.
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

		// The size declared at init does not bind the bytes: the signature of each
		// part does not limit content-length. The feed limit is applied here, over
		// the REAL written size, and an oversized object is deleted so it neither
		// takes up space nor enters the catalog.
		if (Number(head.sizeBytes) > feed.maxUploadBytes) {
			await store.deleteObject(session.key).catch(() => {});
			uploadSessions.delete(req.params.uploadId);
			return res.status(409).json({
				error: `Uploaded file is larger than allowed for ${feed.name} (${Math.round(head.sizeBytes / 1024 / 1024)}MB > ${Math.round(feed.maxUploadBytes / 1024 / 1024)}MB)`,
				code: 'FEED_FILE_TOO_LARGE',
			});
		}

		// Stored on the session so the commit uses what the server verified, not
		// what the client claims.
		session.stored = {
			fileName: session.fileName,
			objectKey: session.key,
			sha256,
			sizeBytes: Number(head.sizeBytes),
			contentType: session.contentType,
		};
		res.json({ uploadId: req.params.uploadId, fileName: session.fileName, sizeBytes: Number(head.sizeBytes) });
	} catch (error) {
		console.error('Ingest upload complete error:', error);
		// The object may already be complete in the bucket, so the session is kept
		// alive and the client can retry instead of sending everything again.
		res.status(500).json({ error: 'Internal server error' });
	}
});

// 4) Registers the WHOLE set as one batch. Files that did not change are named
// here by hash, so a batch mixing reused and freshly uploaded files is still
// complete. Nothing is catalogued until this call succeeds.
router.post('/feeds/:feed/uploads/commit', requireTriage, async (req, res) => {
	try {
		const feed = resolveFeedAndFile(req, res);
		if (!feed) return undefined;

		const uploadIds = (Array.isArray(req.body?.uploadIds) ? req.body.uploadIds : []).map(String);
		// The browser knows when each picked file was last written on the
		// uploader's disk, which is the closest thing we have to when the export
		// was actually taken. Ours is always "just now".
		const sourceDates = req.body?.sourceModifiedAt && typeof req.body.sourceModifiedAt === 'object'
			? req.body.sourceModifiedAt
			: {};
		const sourceDateFor = (fileName) => {
			const value = Number(sourceDates[fileName]);
			if (!Number.isFinite(value) || value <= 0) return null;
			const date = new Date(value);
			// A clock ahead of ours would make the file look fresher than it can
			// possibly be; anything absurd is simply ignored.
			return date > new Date() ? null : date;
		};
		const reuseList = Array.isArray(req.body?.reuse) ? req.body.reuse : [];
		const files = [];

		for (const uploadId of uploadIds) {
			const session = uploadSessions.get(uploadId);
			if (!session || session.feed !== feed.name || !session.stored) {
				return res.status(409).json({
					error: 'One of the uploads is not finished or no longer exists. Start the upload again.',
					code: 'UPLOAD_SESSION_GONE',
				});
			}
			files.push({ ...session.stored, sourceModifiedAt: sourceDateFor(session.stored.fileName) });
		}

		for (const entry of reuseList) {
			const fileName = String(entry?.fileName || '');
			const sha256 = String(entry?.sha256 || '');
			if (!feed.files.includes(fileName) || !/^[a-f0-9]{64}$/i.test(sha256)) {
				return res.status(400).json({ error: 'Invalid file name or sha256 in the reuse list' });
			}
			const existing = await catalog.findArtifactByHash(prisma, feed.name, fileName, sha256);
			if (!existing) {
				return res.status(409).json({ error: `No stored file with that content for ${fileName}`, code: 'FEED_HASH_UNKNOWN' });
			}
			files.push({
				fileName: existing.fileName,
				objectKey: existing.objectKey,
				sha256: existing.sha256,
				sizeBytes: Number(existing.sizeBytes),
				contentType: existing.contentType,
				sourceModifiedAt: sourceDateFor(existing.fileName) || existing.sourceModifiedAt,
			});
		}

		if (files.length === 0) return res.status(400).json({ error: 'Nothing to commit' });

		// A file the person did not send is CARRIED FORWARD from the current
		// batch, so each file of a multi-file feed can be updated on its own.
		// The vendor does not always send both at the same time (the QuickBooks
		// exports are taken separately, and Quadratec ships the sheet and the CSV
		// on their own schedules), and refusing the upload just meant the new
		// file never arrived. The batch still ends up covering every file, which
		// is what keeps the feed readable.
		const names = files.map((file) => file.fileName);
		const missing = feed.files.filter((name) => !names.includes(name));
		let carriedForward = [];

		if (missing.length > 0) {
			const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
			if (!current) {
				return res.status(409).json({
					error: `Feed ${feed.name} has no previous file to complete the batch with, so this first upload needs all of them. Missing: ${missing.join(', ')}`,
					code: 'FEED_BATCH_INCOMPLETE',
				});
			}

			carriedForward = missing.map((name) => {
				const previous = current.artifacts.find((artifact) => artifact.fileName === name);
				return {
					fileName: previous.fileName,
					objectKey: previous.objectKey,
					sha256: previous.sha256,
					sizeBytes: Number(previous.sizeBytes),
					contentType: previous.contentType,
					sourceModifiedAt: previous.sourceModifiedAt,
					uploadedAt: previous.uploadedAt,
				};
			});
			files.push(...carriedForward.map(({ uploadedAt, ...file }) => file));
		}

		const { batchId, artifacts } = await catalog.registerArtifacts(prisma, {
			feed: feed.name,
			source: 'manual',
			uploadedBy: req.user.username,
			note: req.body?.note ? String(req.body.note).slice(0, 2000) : null,
			files,
		});

		uploadIds.forEach((uploadId) => uploadSessions.delete(uploadId));
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		res.status(201).json({
			batchId,
			artifacts: artifacts.map(serializeArtifact),
			isCurrent: current?.batchId === batchId,
			reused: reuseList.length,
			uploaded: uploadIds.length,
			// So the panel can say WHICH file was kept and from when, instead of
			// letting someone believe they just refreshed the whole feed.
			carriedForward: carriedForward.map((file) => ({
				fileName: file.fileName,
				uploadedAt: file.uploadedAt,
			})),
		});
	} catch (error) {
		console.error('Ingest upload commit error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Explicit cancel (the user closed the window halfway through): without this
// the parts keep taking up space in the bucket until the lifecycle policy
// cleans them up.
router.delete('/feeds/:feed/uploads/:uploadId', requireTriage, async (req, res) => {
	const session = uploadSessions.get(req.params.uploadId);
	if (!session || session.feed !== req.params.feed) return res.status(204).end();

	if (session.stored) {
		// The multipart already finished, so there is a real object sitting in the
		// bucket with nothing pointing at it. Aborting a finished upload does
		// nothing, the object has to be deleted by key.
		await store.deleteObject(session.key).catch(() => {});
	} else {
		await store.abortMultipartUpload({ key: session.key, uploadId: req.params.uploadId }).catch(() => {});
	}
	uploadSessions.delete(req.params.uploadId);
	res.status(204).end();
});

// Manual upload from the panel: requires triage and the COMPLETE set of files
// of the feed in a single request (a partial batch never becomes current; the
// CLI covers the advanced case of completing a batch with --batch).
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
			// Multer decodes filename as latin1, same fix as routes/requests.js.
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
		// Same rule as the direct upload: what is not sent is carried forward
		// from the current batch, so one file of a multi-file feed can be
		// refreshed on its own.
		const missing = feed.files.filter((name) => !names.includes(name));
		const currentBatch = missing.length > 0
			? await catalog.getCurrentBatch(prisma, feed.name, feed.files)
			: null;
		if (missing.length > 0 && !currentBatch) {
			return res.status(409).json({
				error: `Feed ${feed.name} has no previous file to complete the batch with, so this first upload needs all of them. Missing: ${missing.join(', ')}`,
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

		for (const name of missing) {
			const previous = currentBatch.artifacts.find((artifact) => artifact.fileName === name);
			files.push({
				fileName: previous.fileName,
				objectKey: previous.objectKey,
				sha256: previous.sha256,
				sizeBytes: Number(previous.sizeBytes),
				contentType: previous.contentType,
				sourceModifiedAt: previous.sourceModifiedAt,
			});
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

// "Run now": runs the script of that feed on the server to check the file that
// was just uploaded without waiting for seed-all. Asynchronous: the panel
// follows it through GET .../run-status. Triage only (the script writes to
// VendorProduct in production).
// Go get the file at the vendor NOW. The schedule (4:47 and 16:47) is a guess
// about when Keystone publishes, and when it guesses early the run succeeds with
// the previous day's file and there is no way to ask again until the next window.
router.post('/feeds/:feed/fetch', requireTriage, (req, res) => {
	try {
		const record = runner.start(req.params.feed, { startedBy: req.user.username, mode: 'fetch' });
		res.status(202).json(record);
	} catch (error) {
		if (error.code === 'FEED_UNKNOWN') {
			return res.status(404).json({ error: error.message, code: error.code });
		}
		if (error.code === 'FEED_RUN_NOT_ALLOWED' || error.code === 'FEED_RUN_BUSY') {
			return res.status(409).json({ error: error.message, code: error.code });
		}
		console.error('Ingest fetch route error:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

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

router.get('/feeds/:feed/run-status', requireTriage, async (req, res) => {
	const status = await runner.getStatus(String(req.params.feed));
	if (!status) return res.status(404).json({ error: 'No run for this feed in the current server session' });
	// logFile is an internal container path; the log tail carries raw seed output
	// (which a future script could print with an auth header), so it is redacted.
	const { logFile, ...safe } = status;
	res.json({ ...safe, logTail: redactLogTail(status.logTail) });
});

// Multer rejects oversized or too many files BEFORE the handler runs, and its
// error carries no status, so it used to reach the global handler and answer
// 500 "Internal Server Error" after the whole upload.
router.use((error, req, res, next) => {
	if (!(error instanceof multer.MulterError)) return next(error);

	const message = {
		LIMIT_FILE_SIZE: `File too large for the panel (max ${Math.round(feedsConfig.config.uploadPanelMaxBytes / 1024 / 1024)}MB). Use the CLI for bigger files.`,
		LIMIT_FILE_COUNT: 'Too many files in one upload.',
		LIMIT_PART_COUNT: 'Too many parts in one upload.',
		LIMIT_FIELD_VALUE: 'One of the fields is too long.',
	}[error.code] || `Upload rejected: ${error.code}`;

	res.status(409).json({ error: message, code: error.code });
});

module.exports = router;
