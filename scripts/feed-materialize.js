/* eslint-disable no-console */
// Materializa um feed do catalogo/Spaces no cache local e imprime o resultado.
// Uso: node scripts/feed-materialize.js <feed> [--json]
//
// Com --json a saida de stdout e UMA linha JSON (warnings vao para stderr) —
// e o contrato do shim materializeFeedSync() em lib/feeds/materialize.js.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createMaterializer } = require('../lib/feeds/materialize');

async function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes('--json');
	const feedName = args.find((arg) => !arg.startsWith('--'));

	if (!feedName) {
		console.error('Uso: node scripts/feed-materialize.js <feed> [--json]');
		process.exitCode = 1;
		return;
	}

	const store = createFeedStore();
	if (!store.isConfigured()) {
		console.error('DO_SPACES_* ausentes no ambiente — feed store nao configurado');
		process.exitCode = 1;
		return;
	}

	const materializer = createMaterializer({ store, prisma });
	const result = await materializer.materializeFeed(feedName);

	if (asJson) {
		console.log(JSON.stringify(result));
	} else {
		console.log(`✅ Feed ${feedName} materializado em ${result.dir} (batch ${result.batchId}${result.stale ? ', STALE' : ''})`);
		for (const [fileName, filePath] of Object.entries(result.files)) {
			console.log(`   ${fileName} -> ${filePath}`);
		}
	}
}

main()
	.catch((error) => {
		console.error(`❌ ${error.code || 'ERRO'}: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
