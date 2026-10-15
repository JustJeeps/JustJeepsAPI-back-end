/* eslint-disable no-console */
// Manual feed upload to the landing zone in Spaces + catalog.
// Usage: npm run feed-upload -- <feed> <file...> [--note "..."] [--by user]
//                              [--as canonicalName] [--batch batchId]
//        npm run feed-upload -- --archive <file...> [--note "..."]
//
// - Each file is recognised by its COLUMNS (config/feeds.js fileSpecs), not by
//   its name: "gold kit 10.13.26.xlsx" is catalogued as pricingKit_quad.xlsx.
//   When two files of the feed share a header (Keystone) the basename breaks
//   the tie. --as <canonicalName> (single file) names it explicitly, and the
//   columns are still checked against that name.
// - Multi-file feed: upload them all together (one batch) or complete an
//   existing partial batch with --batch <id>; an incomplete batch does NOT
//   become the current one.
// - --archive: preserves a file with NO reader (orphans) under feeds/_archive/
//   in the bucket; catalogued with feed "_archive", outside the registry and
//   outside the sync.
// - This is an intentional write to production (same trust model as the
//   seeds): it requires DATABASE_URL + DO_SPACES_* in the environment.

const os = require('os');
const path = require('path');
const fs = require('fs');

const prisma = require('../lib/prisma');
const catalog = require('../lib/feeds/catalog');
const feedsConfig = require('../config/feeds');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { hashFile } = require('../lib/ingest/fileHash');
const { classifyLocalFile, verifyLocalFile } = require('../services/feeds/signatureCheck');
const { diffSignature } = require('../lib/feeds/fileSignature');

const CONTENT_TYPES = {
	'.csv': 'text/csv',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
};

function parseArgs(argv) {
	const args = { files: [], note: null, by: null, as: null, batch: null, archive: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--note') args.note = argv[++i];
		else if (arg === '--by') args.by = argv[++i];
		else if (arg === '--as') args.as = argv[++i];
		else if (arg === '--batch') args.batch = argv[++i];
		else if (arg === '--archive') args.archive = true;
		else if (!args.feed && !args.archive) args.feed = arg;
		else args.files.push(arg);
	}
	return args;
}

const listColumns = (columns) => (columns.length ? columns.map((column) => `"${column}"`).join(', ') : 'none');

// Which canonical file of the feed is this? By columns; the basename only
// breaks a tie. Returns the canonical name or null after printing why not.
function resolveFileName(feed, filePath, asName) {
	const baseName = path.basename(filePath);
	if (asName) {
		if (!feed.files.includes(asName)) {
			console.error(`"${asName}" is not a file of feed ${feed.name} (its files: ${feed.files.join(', ')})`);
			return null;
		}
		const result = verifyLocalFile(filePath, { feed: feed.name, fileName: asName });
		if (!result.ok) {
			console.error(`❌ ${baseName}: ${result.message}`);
			return null;
		}
		return asName;
	}

	const { matches, ambiguous, rows } = classifyLocalFile(filePath, { feed: feed.name, originalName: baseName });
	if (ambiguous) {
		console.error(`❌ ${baseName} has the columns of more than one file of feed ${feed.name}: ${matches.map((m) => m.fileName).join(', ')}. Say which one with --as <name>.`);
		return null;
	}
	if (matches.length === 0) {
		console.error(`❌ ${baseName} does not have the columns of any file of feed ${feed.name}:`);
		for (const spec of feed.fileSpecs) {
			const diff = diffSignature(rows, spec.signature);
			console.error(`   as ${spec.label} (${spec.name}): missing ${listColumns(diff.missing)}; unexpected ${listColumns(diff.extra)}`);
		}
		console.error('   Check that you picked the right file, or that the vendor did not change its layout (then update config/feeds.js).');
		return null;
	}
	const [match] = matches;
	console.log(`🔎 ${baseName} detected as ${match.label} (${match.fileName})`);
	return match.fileName;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if ((!args.feed && !args.archive) || args.files.length === 0) {
		console.error('Usage: npm run feed-upload -- <feed> <file...> [--note "..."] [--by user] [--as name] [--batch id]');
		console.error('       npm run feed-upload -- --archive <file...> [--note "..."]');
		process.exitCode = 1;
		return;
	}

	// Archive mode: any basename, synthetic "_archive" feed, never enters the
	// registry nor the feed-sync, it is only auditable preservation.
	const feed = args.archive
		? { name: '_archive', files: null }
		: feedsConfig.getFeedByName(args.feed);
	if (!feed) {
		console.error(`Unknown feed: ${args.feed}. Valid feeds: ${feedsConfig.getFeedDefinitions().map((f) => f.name).join(', ')}`);
		process.exitCode = 1;
		return;
	}
	if (args.as && args.files.length > 1) {
		console.error('--as is only valid for a single file upload');
		process.exitCode = 1;
		return;
	}

	const store = createFeedStore();
	if (!store.isConfigured()) {
		console.error('DO_SPACES_* missing from the environment: feed store is not configured');
		process.exitCode = 1;
		return;
	}

	const uploads = [];
	for (const filePath of args.files) {
		if (!fs.existsSync(filePath)) {
			console.error(`File not found: ${filePath}`);
			process.exitCode = 1;
			return;
		}
		// Archive mode keeps any basename; a registry feed goes by the columns.
		const fileName = feed.files ? resolveFileName(feed, filePath, args.as) : path.basename(filePath);
		if (!fileName) {
			process.exitCode = 1;
			return;
		}
		if (uploads.some((upload) => upload.fileName === fileName)) {
			console.error(`Two of the given files are both ${fileName}; send one per canonical file`);
			process.exitCode = 1;
			return;
		}
		uploads.push({ filePath, fileName });
	}

	const files = [];
	for (const upload of uploads) {
		const sha256 = await hashFile(upload.filePath);
		const stats = fs.statSync(upload.filePath);
		const sizeBytes = stats.size;
		// The date the export actually carries, before it becomes a symlink into
		// the download cache and loses it.
		const sourceModifiedAt = stats.mtime;
		const contentType = CONTENT_TYPES[path.extname(upload.fileName).toLowerCase()] || 'application/octet-stream';

		// Identical content already in the bucket? Do not resend it (SpecialOrder
		// is 460MB). The object is immutable and content addressed: the new
		// artifact can safely point at the same key.
		const existing = args.archive
			? null
			: await catalog.findArtifactByHash(prisma, feed.name, upload.fileName, sha256);
		if (existing) {
			console.log(`♻️  ${upload.fileName} is already in the bucket with this content (sha ${sha256.slice(0, 8)}), reusing it`);
			files.push({
				fileName: upload.fileName,
				objectKey: existing.objectKey,
				sha256,
				sizeBytes: Number(existing.sizeBytes),
				contentType: existing.contentType || contentType,
				sourceModifiedAt,
			});
			continue;
		}

		const key = store.buildKey({ feed: feed.name, fileName: upload.fileName, sha256 });
		console.log(`⬆️  Uploading ${upload.fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB, sha ${sha256.slice(0, 8)})...`);
		await store.putFile({ key, filePath: upload.filePath, contentType, sizeBytes });
		files.push({ fileName: upload.fileName, objectKey: key, sha256, sizeBytes, contentType, sourceModifiedAt });
	}

	// What was not given is carried forward from the newest stored copy of
	// each file (same rule as the panel, see carryForwardMissing in
	// routes/ingest.js), so a single file of a multi-file feed can be
	// refreshed on its own (the vendor does not always send both at once).
	// Per file and not from the current batch, so a feed that just gained a
	// file still carries the old ones. --batch is left alone: there the caller
	// is deliberately completing an existing batch by hand.
	if (!args.archive && !args.batch) {
		const missingNow = feed.files.filter((name) => !files.some((file) => file.fileName === name));
		if (missingNow.length > 0) {
			const latest = await catalog.getLatestArtifacts(prisma, feed.name, missingNow);
			for (const name of missingNow) {
				const previous = latest[name];
				if (!previous) continue; // never stored: reported as INCOMPLETE below
				console.log(`📎 ${name} kept from its latest stored copy (uploaded ${previous.uploadedAt.toISOString().slice(0, 16)})`);
				files.push({
					fileName: previous.fileName,
					objectKey: previous.objectKey,
					sha256: previous.sha256,
					sizeBytes: Number(previous.sizeBytes),
					contentType: previous.contentType,
					sourceModifiedAt: previous.sourceModifiedAt,
				});
			}
		}
	}

	const { batchId, artifacts } = await catalog.registerArtifacts(prisma, {
		feed: feed.name,
		batchId: args.batch || undefined,
		source: 'manual',
		uploadedBy: args.by || os.userInfo().username,
		note: args.note,
		files,
	});

	console.log(`\n✅ Batch ${batchId} catalogued for feed ${feed.name}:`);
	for (const artifact of artifacts) {
		console.log(`   #${artifact.id} ${artifact.fileName} sha ${artifact.sha256.slice(0, 12)} -> ${artifact.objectKey}`);
	}

	if (args.archive) {
		console.log('\n📦 Archived under feeds/_archive, outside the feed registry and the feed-sync.');
		return;
	}

	const missing = feed.files.filter((name) => !files.some((file) => file.fileName === name));
	if (missing.length > 0 && !args.batch) {
		console.warn(`\n⚠️  WARNING: INCOMPLETE batch, missing: ${missing.join(', ')}.`);
		console.warn(`   Feed ${feed.name} will NOT use this batch until you complete it:`);
		console.warn(`   npm run feed-upload -- ${feed.name} <files> --batch ${batchId}`);
	} else {
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		console.log(current && current.batchId === batchId
			? `\n🎯 Batch ${batchId} is now the current one for feed ${feed.name}.`
			: `\n⚠️  Batch ${batchId} is still NOT the current one (check for missing files/quarantine).`);
	}
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
