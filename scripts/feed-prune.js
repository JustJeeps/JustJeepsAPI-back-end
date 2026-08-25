/* eslint-disable no-console */
// Retencao dos objetos de feed no DO Spaces: mantem as N versoes mais recentes
// de cada arquivo (por feed) e apaga o resto do bucket. A regra pura mora em
// lib/feeds/retention.js — este script so faz o I/O.
//
// Usage: npm run feed-prune                       (dry-run: imprime o plano)
//        npm run feed-prune -- --apply            (executa as delecoes)
//        npm run feed-prune -- --feed keystone-ftp --apply
//        npm run feed-prune -- --keep 3 --grace-hours 48
//
// O default e DRY-RUN de proposito: o cron usa o npm script feed-prune-apply,
// que passa --apply explicitamente. Com --apply, as linhas do catalogo cujo
// objeto vai sumir viram status "purged" ANTES do delete — assim o dedupe
// (findArtifactByHash) para de oferecer a chave enquanto ela ainda existe, e
// um delete que falhar deixa o objeto como candidato de novo na proxima rodada.
//
// Escopo rigido: so objetos sob feeds/<feed do config/feeds.js>/. _archive,
// prefixos legados (quadratec-pricing, quadratec-wholesale), logs/, certs/ e
// anexos de requests nunca sao tocados.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const feedsConfig = require('../config/feeds');
const { planRetention, DEFAULT_KEEP_VERSIONS, DEFAULT_GRACE_MS } = require('../lib/feeds/retention');

function parseArgs(argv) {
	const args = { apply: false, feeds: [], keep: null, graceHours: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--apply') args.apply = true;
		else if (arg === '--feed') args.feeds.push(argv[++i]);
		else if (arg === '--keep') args.keep = Number(argv[++i]);
		else if (arg === '--grace-hours') args.graceHours = Number(argv[++i]);
		else throw new Error(`Unknown option: ${arg}`);
	}
	return args;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const store = createFeedStore();
	if (!store.isConfigured()) {
		console.error('❌ DO Spaces is not configured (DO_SPACES_ENDPOINT/BUCKET/KEY/SECRET)');
		process.exitCode = 1;
		return;
	}
	const keyPrefix = store.keyPrefix();
	if (!keyPrefix) throw new Error('Empty feeds key prefix — refusing to scan the whole bucket');

	const feedNames = feedsConfig.getFeedDefinitions().map((feed) => feed.name);
	for (const name of args.feeds) {
		if (!feedNames.includes(name)) throw new Error(`Unknown feed: ${name} (see config/feeds.js)`);
	}

	const keepVersions = args.keep
		?? (process.env.FEED_PRUNE_KEEP_VERSIONS ? Number(process.env.FEED_PRUNE_KEEP_VERSIONS) : DEFAULT_KEEP_VERSIONS);
	const graceMs = args.graceHours !== null
		? args.graceHours * 60 * 60 * 1000
		: (process.env.FEED_PRUNE_GRACE_HOURS ? Number(process.env.FEED_PRUNE_GRACE_HOURS) * 60 * 60 * 1000 : DEFAULT_GRACE_MS);
	if (!Number.isFinite(keepVersions) || keepVersions < 1) throw new Error(`Invalid keepVersions: ${keepVersions}`);
	if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error(`Invalid grace window: ${graceMs}`);

	console.log(`Feed retention — keep ${keepVersions} version(s) per file, grace ${Math.round(graceMs / 3600000)}h`);
	console.log(`Bucket ${store.bucket()}, prefix ${keyPrefix}/ ${args.apply ? '(APPLY)' : '(dry-run)'}\n`);

	const objects = await store.listObjects(`${keyPrefix}/`);
	// Select minimo e sem BigInt (sizeBytes fora): os bytes do relatorio vem do
	// listing do bucket, que e a verdade sobre o que sera liberado.
	const artifacts = await prisma.feedArtifact.findMany({
		select: { feed: true, fileName: true, objectKey: true, status: true, uploadedAt: true },
	});

	const planned = planRetention({ objects, artifacts, feedNames, keyPrefix, keepVersions, graceMs });
	// --feed restringe só a EXECUÇÃO; a proteção é sempre computada global.
	const toDelete = args.feeds.length
		? planned.toDelete.filter((object) => args.feeds.some((name) => object.key.startsWith(`${keyPrefix}/${name}/`)))
		: planned.toDelete;

	const { report } = planned;
	for (const [feed, entry] of Object.entries(report.feeds)) {
		const scoped = args.feeds.length && !args.feeds.includes(feed) ? ' (out of --feed scope)' : '';
		const eligibility = entry.eligible ? '' : ' — NOT eligible (no available row), report-only';
		console.log(`  ${feed}: ${entry.objects} object(s), delete ${entry.toDelete.count} (${mb(entry.toDelete.bytes)}), orphans ${entry.orphans}${eligibility}${scoped}`);
	}
	if (report.archive.count) console.log(`  _archive: ${report.archive.count} object(s), ${mb(report.archive.bytes)} — untouched`);
	for (const [name, entry] of Object.entries(report.unknownPrefixes)) {
		console.log(`  ${name}: ${entry.count} object(s), ${mb(entry.bytes)} — unknown prefix, untouched`);
	}
	if (planned.missingFromBucket.length) {
		console.log(`  ⚠️  ${planned.missingFromBucket.length} catalog key(s) missing from the bucket (dead keys, report-only):`);
		for (const key of planned.missingFromBucket) console.log(`      ${key}`);
	}
	const totalBytes = toDelete.reduce((total, object) => total + Number(object.size || 0), 0);
	console.log(`\nPlan: delete ${toDelete.length} object(s), ${mb(totalBytes)} freed.`);

	if (!args.apply) {
		if (toDelete.length) {
			console.log('\nKeys to delete:');
			for (const object of toDelete) console.log(`  ${object.key}`);
		}
		console.log('\nDry-run only. Re-run with --apply to execute.');
		return;
	}

	if (!toDelete.length) {
		console.log('Nothing to delete.');
		return;
	}

	// purged ANTES do delete (ver comentario do topo). Por construcao, so
	// linhas superseded apontam para toDelete — available/quarantined estao no
	// piso protegido do planRetention.
	const keys = toDelete.map((object) => object.key);
	const { count: purgedCount } = await prisma.feedArtifact.updateMany({
		where: { objectKey: { in: keys }, status: 'superseded' },
		data: { status: 'purged' },
	});
	console.log(`\nMarked ${purgedCount} catalog row(s) as purged.`);

	let failures = 0;
	for (const object of toDelete) {
		try {
			await store.deleteObject(object.key);
			console.log(`  🗑  ${object.key} (${mb(Number(object.size || 0))})`);
		} catch (error) {
			failures += 1;
			console.error(`  ❌ ${object.key}: ${error.message}`);
		}
	}
	console.log(`\nDeleted ${toDelete.length - failures}/${toDelete.length} object(s), ${mb(totalBytes)} freed.`);
	if (failures) {
		console.error(`❌ ${failures} delete(s) failed — the purged rows stay purged and the objects remain candidates next run.`);
		process.exitCode = 1;
	}
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
