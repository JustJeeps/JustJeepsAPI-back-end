/* eslint-disable no-console */
// Registers the Omix-ADA "Replace OE" cross references as Product Replacement
// pairs (Omix SKU -> Crown SKU). The Replacements lookup is symmetric and follows
// links, so the buyer sees the alternatives on the Orders screen whichever part
// of the group is on the line. Docs: docs/PRODUCT-REPLACEMENTS.md, "Automatic rows from the Omix OE
// file". The decisions live in lib/productReplacements/omixOeImport.js and the
// data access in services/productReplacements/omixOeImportService.js; this file
// only wires them, prints the report and sets the exit code.
//
// Usage:
//   npm run import-omix-oe-replacements                 # DRY RUN: shows what it would create
//   npm run import-omix-oe-replacements-apply           # creates the pairs as the "admin" user
//   npm run import-omix-oe-replacements -- --as tess    # another author (username)
//   npm run import-omix-oe-replacements -- --all        # dry run listing every planned pair
//
// Re-runnable: pairs that exist are skipped, pairs removed by hand are never
// recreated, sources marked "no replacement" are left alone, odd OE values
// (several numbers, J prefix, leading zero) are listed for a human.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = require('../lib/prisma');
const { createProductReplacementsService } = require('../services/productReplacements/productReplacementsService');
const { createOmixOeImportService, findImportUser } = require('../services/productReplacements/omixOeImportService');
const { SERVICE_CONFIG, isReplacementsManager } = require('../config/productReplacements');

const DEFAULT_AUTHOR = 'admin';
const SAMPLE_SIZE = 10;

const parseArgs = (argv) => {
	const args = { confirm: false, all: false, as: DEFAULT_AUTHOR };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--confirm') args.confirm = true;
		else if (argv[i] === '--all') args.all = true;
		else if (argv[i] === '--as') args.as = String(argv[++i] ?? '');
		else if (argv[i].startsWith('--as=')) args.as = argv[i].slice('--as='.length);
		else throw new Error(`Unknown argument: ${argv[i]}`);
	}
	if (!args.as.trim()) throw new Error('--as needs a username');
	return args;
};

const displayName = (user) => [user.firstname, user.lastname].filter(Boolean).join(' ').trim() || user.username;

function printReport(report, author, { all = false } = {}) {
	const { totals, skipped, creates, created, failed, pairsNotCreated } = report;
	const banner = !report.confirm ? '🔎 DRY RUN' : (failed.length > 0 ? '⚠️  IMPORT WITH FAILURES' : '✅ IMPORT');
	console.log(`${banner}: Omix Replace OE -> Product Replacements, author ${displayName(author)} (${author.username})`);
	console.log(`   Omix products with a Replace OE: ${totals.sources}`);
	console.log(`   OE groups with a Crown part in the catalog: ${totals.groups}`);
	console.log(`   Pairs to create: ${totals.pairsToCreate} (from ${creates.length} source SKUs)`);
	console.log(`   Already registered (active): ${skipped.alreadyActive}`);
	console.log(`   Removed by hand earlier (kept removed): ${skipped.removedBefore}`);
	console.log(`   No Crown variant in the catalog: ${skipped.noVariantInCatalog}`);
	console.log(`   Blank OE value: ${skipped.blankOe}`);
	console.log(`   Blocked by a "no replacement" marker: ${skipped.blockedByMarker.length}${skipped.blockedByMarker.length ? ` (${skipped.blockedByMarker.join(', ')})` : ''}`);
	console.log(`   OE values left to a human: ${skipped.anomalies.length}`);
	for (const entry of skipped.anomalies) {
		console.log(`      ${entry.sku.padEnd(16)} ${entry.replace_oe.padEnd(24)} ${entry.anomalies.join(', ')}`);
	}

	if (!report.confirm) {
		const sample = all ? creates : creates.slice(0, SAMPLE_SIZE);
		if (sample.length > 0) {
			console.log(`\n   ${all ? 'Every' : `First ${sample.length}`} source SKU${sample.length === 1 ? '' : 's'} that would get pairs${all ? '' : ' (--all lists them all)'}:`);
			for (const entry of sample) {
				console.log(`      ${entry.source_sku} -> ${entry.replacements.map((r) => r.replacement_sku).join(', ')}`);
			}
		}
		console.log('\nNothing was changed. Review the numbers and run again with --confirm.');
		return;
	}

	console.log(`\n   Pairs created: ${created}`);
	if (failed.length > 0) {
		console.log(`   Pairs NOT created: ${pairsNotCreated} in ${failed.length} source SKU${failed.length === 1 ? '' : 's'}:`);
		for (const entry of failed) console.log(`      ${entry.source_sku} (${entry.pairs} pair${entry.pairs === 1 ? '' : 's'}): ${entry.code} ${entry.message}`);
	}
	console.log(`\nRESULT: ${created} of ${totals.pairsToCreate} planned pairs created${failed.length > 0 ? `, ${pairsNotCreated} not created (see above); re-run to retry, pairs already created are skipped` : ''}.`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const author = await findImportUser(prisma, args.as);
	if (!author) {
		throw new Error(`User "${args.as}" was not found; pass --as <username> with an existing user`);
	}

	const replacementsService = createProductReplacementsService({
		prisma,
		config: SERVICE_CONFIG,
		isManager: isReplacementsManager,
	});
	const importer = createOmixOeImportService({ prisma, replacementsService, log: console });

	const report = await importer.run({ user: { id: author.id, username: author.username }, confirm: args.confirm });
	printReport(report, author, { all: args.all });

	if (report.failed.length > 0) process.exitCode = 1;
}

main()
	.catch((error) => {
		console.error(`❌ ${error.code ? `[${error.code}] ` : ''}${error.message}`);
		if (error.partialReport) {
			const { created, failed, processed, total } = error.partialReport;
			console.error(`RUN ABORTED at source ${processed + 1} of ${total}: ${created} pairs created before the error, ${failed.length} source SKUs failed on a rule.`);
			console.error('Each source is its own transaction: what was created stays. Re-run is safe, pairs already created are skipped.');
		}
		if (error.stack) console.error(error.stack);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
