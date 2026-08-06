/* eslint-disable no-console */
// Manual feed upload to the landing zone in Spaces + catalog.
// Usage: npm run feed-upload -- <feed> <file...> [--note "..."] [--by user]
//                              [--as canonicalName] [--batch batchId]
//        npm run feed-upload -- --archive <file...> [--note "..."]
//
// - The basename of each file (or --as, for a single file) has to be one of
//   the canonical names of the feed in config/feeds.js.
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
		const fileName = args.as || path.basename(filePath);
		if (feed.files && !feed.files.includes(fileName)) {
			console.error(`"${fileName}" is not an expected file of feed ${feed.name} (expected: ${feed.files.join(', ')})`);
			process.exitCode = 1;
			return;
		}
		uploads.push({ filePath, fileName });
	}

	const files = [];
	for (const upload of uploads) {
		const sha256 = await hashFile(upload.filePath);
		const sizeBytes = fs.statSync(upload.filePath).size;
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
			});
			continue;
		}

		const key = store.buildKey({ feed: feed.name, fileName: upload.fileName, sha256 });
		console.log(`⬆️  Uploading ${upload.fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB, sha ${sha256.slice(0, 8)})...`);
		await store.putFile({ key, filePath: upload.filePath, contentType, sizeBytes });
		files.push({ fileName: upload.fileName, objectKey: key, sha256, sizeBytes, contentType });
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
