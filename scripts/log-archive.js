#!/usr/bin/env node
// Reads the run logs archived in DO Spaces (see services/logArchive/logArchiveService.js).
//
// This exists because the copy on the droplet is not the source of truth: those
// files are append-only, they are pruned on the volume, and container stdout is
// gone on the next deploy. The archive is what you read the morning after.
//
//   npm run log-archive -- list
//   npm run log-archive -- list --command seed-omix --failed
//   npm run log-archive -- list --date 2026-08-07 --limit 50
//   npm run log-archive -- get logs/cron/feed-fetch-keystone/2026/08/07/...log
//   npm run log-archive -- last --command feed-fetch-keystone

const { createFeedStore } = require('../lib/feeds/feedStore');
const { DEFAULT_PREFIX } = require('../lib/logArchive/keys');

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith('--')) { args._.push(token); continue; }
		const name = token.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) { args[name] = true; continue; }
		args[name] = next;
		i += 1;
	}
	return args;
}

const prefix = (process.env.DO_SPACES_LOGS_PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');

// Keys are <prefix>/<source>/<command>/<Y>/<M>/<D>/<stamp>-<status>.log, so the
// listing prefix narrows server-side whenever a command is given.
function listPrefixFor({ command, source }) {
	if (!command) return `${prefix}/`;
	return `${prefix}/${source || 'cron'}/${command}/`;
}

function describe(item) {
	const status = /-failed\./.test(item.key) ? 'FAILED ' : 'ok     ';
	const kb = `${Math.max(1, Math.round(item.size / 1024))}KB`.padStart(8);
	return `${status}${item.lastModified?.toISOString?.() || ''} ${kb}  ${item.key}`;
}

async function collect(store, args) {
	// A command can be archived under either source (cron for the job itself,
	// seed-all for the step): without an explicit --source, look in both.
	const sources = args.source ? [args.source] : ['cron', 'seed-all'];
	const prefixes = args.command ? sources.map((source) => listPrefixFor({ command: args.command, source })) : [`${prefix}/`];

	const found = [];
	for (const listPrefix of prefixes) {
		found.push(...await store.listObjects(listPrefix));
	}

	return found
		.filter((item) => (args.failed ? /-failed\./.test(item.key) : true))
		.filter((item) => (args.date ? item.key.includes(`/${String(args.date).replace(/-/g, '/')}/`) : true))
		.sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0] || 'list';
	const store = createFeedStore();

	if (!store.isConfigured()) {
		console.error('❌ DO Spaces is not configured (DO_SPACES_ENDPOINT/BUCKET/KEY/SECRET).');
		process.exit(1);
	}

	if (command === 'list' || command === 'last') {
		const items = await collect(store, args);
		if (!items.length) {
			console.log('No archived log matches that filter.');
			return;
		}

		if (command === 'last') {
			const { body } = await store.getObjectStream(items[0].key);
			console.error(`# ${items[0].key}\n`);
			body.pipe(process.stdout);
			return;
		}

		const limit = Number(args.limit || 25);
		items.slice(0, limit).forEach((item) => console.log(describe(item)));
		if (items.length > limit) console.log(`… ${items.length - limit} older entries (use --limit).`);
		return;
	}

	if (command === 'get') {
		const key = args._[1] || args.key;
		if (!key) {
			console.error('Usage: npm run log-archive -- get <key>');
			process.exit(1);
		}
		const { body } = await store.getObjectStream(key);
		body.pipe(process.stdout);
		return;
	}

	console.error(`Unknown command "${command}". Use: list | last | get`);
	process.exit(1);
}

main().catch((error) => {
	console.error(`❌ ${error.message}`);
	process.exit(1);
});
