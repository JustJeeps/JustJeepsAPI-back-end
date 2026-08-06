/* eslint-disable no-console */
// Kill switch for a bad batch: takes it out of circulation so no vendor script
// can read it again.
// Usage: npm run feed-quarantine -- <feed> [batchId] --note "why"
//        npm run feed-quarantine -- <feed> --list
//
// Without a batchId it acts on the batch that is current right now, which is
// the case that matters: a vendor sent a truncated file, it was catalogued, and
// it has to stop being read before tonight's sync.
//
// What happens after: the batch disappears from getCurrentBatch, so the feed
// falls back to the previous complete batch. Run feed-sync afterwards to point
// the legacy paths at it (quarantine removes our symlink, so a script that runs
// in between fails loudly instead of reading condemned data).
//
// This is an intentional write to production (same trust model as the seeds):
// it requires DATABASE_URL in the environment.

const prisma = require('../lib/prisma');
const catalog = require('../lib/feeds/catalog');
const feedsConfig = require('../config/feeds');

function parseArgs(argv) {
	const args = { feed: null, batchId: null, note: null, list: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--note') args.note = argv[++i];
		else if (arg === '--list') args.list = true;
		else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
		else if (!args.feed) args.feed = arg;
		else if (!args.batchId) args.batchId = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return args;
}

async function listBatches(feed) {
	const artifacts = await prisma.feedArtifact.findMany({
		where: { feed: feed.name },
		orderBy: { uploadedAt: 'desc' },
		take: 100,
	});

	const batches = new Map();
	for (const artifact of artifacts) {
		if (!batches.has(artifact.batchId)) batches.set(artifact.batchId, []);
		batches.get(artifact.batchId).push(artifact);
	}

	const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
	console.log(`\nBatches of feed ${feed.name} (newest first):\n`);
	for (const [batchId, rows] of batches) {
		const uploadedAt = rows.map((row) => row.uploadedAt).sort((a, b) => b - a)[0];
		const statuses = [...new Set(rows.map((row) => row.status))].join('/');
		const marker = batchId === current?.batchId ? ' <- current' : '';
		console.log(`  ${batchId}  ${uploadedAt.toISOString().slice(0, 16)}  ${statuses.padEnd(11)} ${rows.length} file(s)${marker}`);
		for (const row of rows) console.log(`      ${row.fileName} sha ${row.sha256.slice(0, 12)}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.feed) {
		console.error('Usage: npm run feed-quarantine -- <feed> [batchId] --note "why"');
		console.error(`Feeds: ${feedsConfig.getFeedDefinitions().map((feed) => feed.name).join(', ')}`);
		process.exitCode = 1;
		return;
	}

	const feed = feedsConfig.getFeedByName(args.feed);
	if (!feed) throw new Error(`Unknown feed: ${args.feed} (see config/feeds.js)`);

	if (args.list) return listBatches(feed);

	let batchId = args.batchId;
	if (!batchId) {
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		if (!current) throw new Error(`Feed ${feed.name} has no current batch to quarantine`);
		batchId = current.batchId;
		console.log(`No batch given, using the current one: ${batchId}`);
	}

	const { count } = await catalog.quarantineBatch(prisma, batchId, args.note);
	if (count === 0) throw new Error(`No artifact found for batch ${batchId}`);

	console.log(`\n🚫 Batch ${batchId} quarantined (${count} artifact(s))`);

	const next = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
	console.log(next
		? `↩️  Feed ${feed.name} falls back to batch ${next.batchId} (${next.uploadedAt.toISOString().slice(0, 16)})`
		: `⚠️  Feed ${feed.name} now has NO complete batch. Upload a good file before the next sync.`);
	console.log('\nRun "npm run feed-sync -- ' + feed.name + '" to point the legacy paths at the batch above.');
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
