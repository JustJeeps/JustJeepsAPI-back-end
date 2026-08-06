/* eslint-disable no-console */
// Fetch dos feeds Keystone (FTP -> Spaces -> catalogo). Roda pelo cron
// "feed-fetch-keystone" (config/cron-jobs.js) ou manualmente:
//   npm run feed-fetch-keystone
//
// Aquisicao pura: NAO escreve em Product/VendorProduct — o consumo acontece
// no seed-keystone-ftp2 da proxima rodada do seed-all, que materializa o lote
// catalogado aqui.

const prisma = require('../lib/prisma');
const { createFeedStore } = require('../lib/feeds/feedStore');
const { createKeystoneFtpClient } = require('../lib/feeds/keystoneFtp');
const { runKeystoneFetch } = require('../services/feeds/keystoneFetchService');

async function main() {
	const store = createFeedStore();
	if (!store.isConfigured()) {
		throw new Error('DO_SPACES_* ausentes no ambiente — feed store nao configurado');
	}

	const started = Date.now();
	const result = await runKeystoneFetch({
		// store entra aqui porque a CA intermediaria do FTPS da Keystone vive num
		// diretorio privado do bucket (nao no repositorio) — ver lib/feeds/keystoneFtp.js
		ftpClient: createKeystoneFtpClient({ store }),
		store,
		prisma,
	});

	const seconds = ((Date.now() - started) / 1000).toFixed(0);
	if (result.skipped) {
		console.log(`⏭️  Feeds Keystone identicos ao lote corrente (${result.batchId}) — nada a subir (${seconds}s)`);
	} else {
		console.log(`✅ Lote ${result.batchId} catalogado com ${result.files.length} arquivos em ${seconds}s`);
		for (const file of result.files) {
			console.log(`   ${file.fileName} (${(file.sizeBytes / 1024 / 1024).toFixed(1)}MB) -> ${file.objectKey}`);
		}
	}
}

main()
	.catch((error) => {
		console.error(`❌ Keystone feed fetch falhou: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
