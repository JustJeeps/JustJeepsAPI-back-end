// Sincroniza os feeds do catalogo/Spaces para os CAMINHOS LEGADOS em
// prisma/seeds/api-calls — os seeds continuam lendo os paths de sempre
// (zero diff nos scripts), mas o arquivo por tras e um symlink para o lote
// corrente no cache verificado do materializer.
//
// Semantica por feed:
//   lote completo no catalogo  -> materializa + symlink atomico (synced)
//   sem lote (FEED_NO_ARTIFACT) -> warning e mantem o arquivo existente
//                                  (baked na imagem) durante a transicao (skipped)
//   qualquer outra falha        -> failed (feed-sync sai com exit 1; visivel)
//
// A troca do symlink e atomica: cria link temporario e rename por cima —
// leitores nunca veem caminho quebrado no meio da troca.

const fs = require('fs');
const path = require('path');

// Cria/atualiza symlink em linkPath apontando para targetPath (absoluto).
// Substitui arquivo regular pre-existente (o baked da imagem) via rename.
function ensureLink(linkPath, targetPath) {
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });

	try {
		if (fs.readlinkSync(linkPath) === targetPath) return false; // ja aponta certo
	} catch {
		// nao existe ou nao e symlink — segue para a troca
	}

	const tmpLink = `${linkPath}.tmp-${process.pid}`;
	fs.rmSync(tmpLink, { force: true });
	fs.symlinkSync(targetPath, tmpLink);
	fs.renameSync(tmpLink, linkPath);
	return true;
}

function createLegacySync({
	materializer,
	feedsConfig = require('../../config/feeds'),
	apiCallsDir = path.join(__dirname, '../../prisma/seeds/api-calls'),
	cacheDir = process.env.FEED_CACHE_DIR || path.join(__dirname, '../../feed-cache'),
	logger = console,
} = {}) {
	// Remove apenas symlinks criados por nos (apontando para o cache de feeds).
	// Arquivo comum no caminho legado nunca e tocado.
	function removeOwnLinks(feed) {
		let removed = 0;
		for (const fileName of feed.files) {
			const linkPath = path.join(apiCallsDir, feed.legacyDir || '', fileName);
			try {
				if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath).startsWith(cacheDir)) {
					fs.rmSync(linkPath, { force: true });
					removed += 1;
				}
			} catch {
				// caminho inexistente: nada a remover
			}
		}
		return removed;
	}

	async function syncFeed(feed) {
		const materialized = await materializer.materializeFeed(feed.name);
		const links = [];
		for (const fileName of feed.files) {
			const linkPath = path.join(apiCallsDir, feed.legacyDir || '', fileName);
			const changed = ensureLink(linkPath, materialized.files[fileName]);
			links.push({ fileName, linkPath, target: materialized.files[fileName], changed });
		}
		return { feed: feed.name, batchId: materialized.batchId, stale: materialized.stale, links };
	}

	// Processa todos os feeds do registro; falha de um nao impede os demais.
	async function syncAllFeeds() {
		const synced = [];
		const skipped = [];
		const failed = [];

		for (const feed of feedsConfig.getFeedDefinitions()) {
			try {
				const result = await syncFeed(feed);
				synced.push(result);
				logger.log(
					`🔗 [feed-sync] ${feed.name}: lote ${result.batchId}${result.stale ? ' (STALE)' : ''} -> ${feed.files.length} arquivo(s) em api-calls/${feed.legacyDir || '.'}`
				);
			} catch (error) {
				if (error.code === 'FEED_NO_ARTIFACT') {
					// Sem lote corrente (feed novo ou lote posto em quarentena).
					// Se o caminho legado ainda for um symlink NOSSO, ele aponta
					// para o lote que saiu de circulacao: remover, para o seed
					// falhar alto em vez de reingerir o arquivo condenado. Se for
					// arquivo comum (baked na imagem), mantemos — e a transicao.
					const removed = removeOwnLinks(feed);
					skipped.push({ feed: feed.name, reason: error.message, removedLinks: removed });
					logger.warn(removed > 0
						? `⚠️ [feed-sync] ${feed.name}: sem lote no catalogo — ${removed} link(s) do lote anterior removido(s); o seed vai falhar ate subir um arquivo novo`
						: `⚠️ [feed-sync] ${feed.name}: sem lote no catalogo — mantendo arquivo local existente`);
				} else {
					failed.push({ feed: feed.name, code: error.code || null, error: error.message });
					logger.error(`❌ [feed-sync] ${feed.name}: ${error.message}`);
				}
			}
		}

		return { synced, skipped, failed };
	}

	return { syncFeed, syncAllFeeds };
}

module.exports = { createLegacySync, ensureLink };
