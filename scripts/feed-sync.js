/* eslint-disable no-console */
// Sincroniza os feeds do catalogo/Spaces para os caminhos legados em
// prisma/seeds/api-calls (symlink -> cache verificado). Roda como stage 0 do
// seed-all e manualmente:
//   npm run feed-sync            todos os feeds (modo tolerante)
//   npm run feed-sync -- <feed>  um feed so (modo ESTRITO)
//
// Exit codes: 0 = ok. 1 = falha. No modo "todos", feed sem lote e so warning
// (transicao: o arquivo local existente continua valendo). No modo de um feed
// so — usado pelo botao "Run now" antes de rodar o seed — feed sem lote e
// FALHA: quem pediu para rodar aquele feed espera o arquivo do catalogo.

const prisma = require('../lib/prisma');
const feedsConfig = require('../config/feeds');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createMaterializer } = require('../lib/feeds/materialize');
const { createLegacySync } = require('../lib/feeds/legacySync');

async function main() {
	const onlyFeed = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
	const store = createFeedStore();
	if (!store.isConfigured()) {
		const message = 'DO_SPACES_* ausentes — feed store nao configurado';
		if (onlyFeed) throw new Error(message);
		console.warn(`⚠️ [feed-sync] ${message}; sync pulado, seeds usam os arquivos locais existentes`);
		return;
	}

	const materializer = createMaterializer({ store, prisma });
	const sync = createLegacySync({ materializer });

	if (onlyFeed) {
		const feed = feedsConfig.getFeedByName(onlyFeed);
		if (!feed) throw new Error(`Feed desconhecido: ${onlyFeed}`);
		const result = await sync.syncFeed(feed); // lanca em qualquer falha (modo estrito)
		console.log(`🔗 [feed-sync] ${feed.name}: lote ${result.batchId}${result.stale ? ' (STALE)' : ''} pronto em api-calls/${feed.legacyDir || '.'}`);
		return;
	}

	const { synced, skipped, failed } = await sync.syncAllFeeds();

	console.log(
		`\n📦 [feed-sync] ${synced.length} sincronizado(s), ${skipped.length} sem lote (mantido local), ${failed.length} falha(s)`
	);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

main()
	.catch((error) => {
		console.error(`❌ [feed-sync] ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
