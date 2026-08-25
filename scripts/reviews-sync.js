/* eslint-disable no-console */
// Sync de reviews com o Magento pela linha de comando (paridade com o botao
// do painel /settings > Reviews). Default e DRY-RUN: mostra o que seria
// enviado; enviar exige --apply explicito (mesma regra do feed-prune — o
// POST escreve na loja de PRODUCAO).
//
// Usage: npm run reviews-sync                          (dry-run: lista arquivos e pendencias)
//        npm run reviews-sync -- --file 3 --apply       (sincroniza o arquivo 3)
//        npm run reviews-sync -- --file 3 --retry-failed --apply
//        npm run reviews-sync -- --file 3 --mark-sending-failed
//
// --mark-sending-failed e o escape MANUAL para linhas travadas em 'sending'
// quando a verificacao via GET nao funciona: use SOMENTE depois de conferir
// no admin do Magento que aquelas reviews NAO foram gravadas la.

const prisma = require('../lib/prisma');
const { config: reviewsConfig } = require('../config/reviews');
const { parseWorkbookBuffer } = require('../lib/reviews/parseWorkbook');
const { createReviewImportService } = require('../services/reviews/reviewImportService');
const { createReviewSyncService } = require('../services/reviews/reviewSyncService');
const { createMagentoReviewsClient } = require('../lib/magento/reviewsClient');

function parseArgs(argv) {
	const args = { apply: false, file: null, retryFailed: false, markSendingFailed: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--apply') args.apply = true;
		else if (arg === '--file') args.file = Number(argv[++i]);
		else if (arg === '--retry-failed') args.retryFailed = true;
		else if (arg === '--mark-sending-failed') args.markSendingFailed = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (args.file !== null && (!Number.isInteger(args.file) || args.file <= 0)) {
		throw new Error('Invalid --file id');
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const magentoClient = createMagentoReviewsClient();
	const importService = createReviewImportService({ prisma, config: reviewsConfig, parseWorkbookBuffer });
	const syncService = createReviewSyncService({ prisma, magentoClient, config: reviewsConfig });
	const user = { username: process.env.USER || 'cli' };

	if (args.markSendingFailed) {
		if (!args.file) throw new Error('--mark-sending-failed requires --file <id>');
		const { marked } = await syncService.markSendingFailed({ fileId: args.file });
		console.log(`⚠️  ${marked} row(s) manually marked as failed — only do this after checking Magento.`);
		return;
	}

	if (args.retryFailed) {
		if (!args.file) throw new Error('--retry-failed requires --file <id>');
		const { requeued } = await syncService.retryFailed({ fileId: args.file });
		console.log(`↩️  ${requeued} failed row(s) requeued as pending.`);
		if (!args.apply) return;
	}

	if (!args.apply || !args.file) {
		const listing = await importService.listFiles();
		console.log(`Reviews import — ${listing.files.length} file(s). Batch ${reviewsConfig.batchSize}, delay ${reviewsConfig.batchDelayMs}ms.\n`);
		for (const file of listing.files) {
			const { counts } = file;
			console.log(`  #${file.id} ${file.fileName} (${file.status}) by ${file.uploadedBy} — pending ${counts.pending}, sending ${counts.sending}, synced ${counts.synced}, failed ${counts.failed}, invalid ${file.invalidRowCount}`);
		}
		if (listing.lastRun) {
			console.log(`\nLast run: #${listing.lastRun.id} ${listing.lastRun.status} (${listing.lastRun.startedBy || 'cron'})`);
		}
		console.log('\nDry-run only. Use --file <id> --apply to send the pending rows.');
		return;
	}

	if (!magentoClient.isConfigured()) {
		console.error('❌ MAGENTO_KEY is not configured');
		process.exitCode = 1;
		return;
	}

	console.log(`Syncing file #${args.file} → ${magentoClient.baseUrl()} (batch ${reviewsConfig.batchSize}, delay ${reviewsConfig.batchDelayMs}ms)`);
	const { runId, done } = await syncService.startSync({ user, fileId: args.file });
	console.log(`Run #${runId} started...`);
	await done;
	const run = await prisma.ingestRun.findUnique({ where: { id: runId } });
	console.log(`${run.status === 'success' ? '✅' : '❌'} Run #${runId} ${run.status} — sent ${run.rowsInserted}, recovered ${run.rowsUpdated}, failed rows ${run.rowsSkipped}${run.error ? `, error: ${run.error}` : ''}`);
	if (run.status !== 'success') process.exitCode = 1;
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
