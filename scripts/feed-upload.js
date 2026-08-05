/* eslint-disable no-console */
// Upload manual de feed para o landing zone no Spaces + catalogo.
// Uso: npm run feed-upload -- <feed> <arquivo...> [--note "..."] [--by usuario]
//                             [--as nomeCanonico] [--batch batchId]
//      npm run feed-upload -- --archive <arquivo...> [--note "..."]
//
// - O basename de cada arquivo (ou --as, para arquivo unico) precisa ser um
//   dos nomes canonicos do feed em config/feeds.js.
// - Feed multi-arquivo: suba todos juntos (um lote) ou complete um lote
//   parcial existente com --batch <id> — lote incompleto NAO vira corrente.
// - --archive: preservacao de arquivo SEM leitor (orfaos) sob feeds/_archive/
//   no bucket; catalogado com feed "_archive", fora do registro e do sync.
// - E uma escrita intencional em producao (mesmo modelo de confianca dos
//   seeds): requer DATABASE_URL + DO_SPACES_* no ambiente.

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
		console.error('Uso: npm run feed-upload -- <feed> <arquivo...> [--note "..."] [--by usuario] [--as nome] [--batch id]');
		console.error('     npm run feed-upload -- --archive <arquivo...> [--note "..."]');
		process.exitCode = 1;
		return;
	}

	// Modo arquivo-morto: qualquer basename, feed sintetico "_archive",
	// nunca entra no registro nem no feed-sync — so preservacao auditavel.
	const feed = args.archive
		? { name: '_archive', files: null }
		: feedsConfig.getFeedByName(args.feed);
	if (!feed) {
		console.error(`Feed desconhecido: ${args.feed}. Feeds validos: ${feedsConfig.getFeedDefinitions().map((f) => f.name).join(', ')}`);
		process.exitCode = 1;
		return;
	}
	if (args.as && args.files.length > 1) {
		console.error('--as so vale para upload de arquivo unico');
		process.exitCode = 1;
		return;
	}

	const store = createFeedStore();
	if (!store.isConfigured()) {
		console.error('DO_SPACES_* ausentes no ambiente — feed store nao configurado');
		process.exitCode = 1;
		return;
	}

	const uploads = [];
	for (const filePath of args.files) {
		if (!fs.existsSync(filePath)) {
			console.error(`Arquivo nao encontrado: ${filePath}`);
			process.exitCode = 1;
			return;
		}
		const fileName = args.as || path.basename(filePath);
		if (feed.files && !feed.files.includes(fileName)) {
			console.error(`"${fileName}" nao e um arquivo esperado do feed ${feed.name} (esperados: ${feed.files.join(', ')})`);
			process.exitCode = 1;
			return;
		}
		uploads.push({ filePath, fileName });
	}

	const files = [];
	for (const upload of uploads) {
		const sha256 = await hashFile(upload.filePath);
		const sizeBytes = fs.statSync(upload.filePath).size;
		const key = store.buildKey({ feed: feed.name, fileName: upload.fileName, sha256 });
		const contentType = CONTENT_TYPES[path.extname(upload.fileName).toLowerCase()] || 'application/octet-stream';

		console.log(`⬆️  Subindo ${upload.fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB, sha ${sha256.slice(0, 8)})...`);
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

	console.log(`\n✅ Lote ${batchId} catalogado para o feed ${feed.name}:`);
	for (const artifact of artifacts) {
		console.log(`   #${artifact.id} ${artifact.fileName} sha ${artifact.sha256.slice(0, 12)} -> ${artifact.objectKey}`);
	}

	if (args.archive) {
		console.log('\n📦 Arquivado em feeds/_archive — fora do registro de feeds e do feed-sync.');
		return;
	}

	const missing = feed.files.filter((name) => !files.some((file) => file.fileName === name));
	if (missing.length > 0 && !args.batch) {
		console.warn(`\n⚠️  ATENCAO: lote INCOMPLETO — faltam: ${missing.join(', ')}.`);
		console.warn(`   O feed ${feed.name} NAO vai usar este lote ate voce completa-lo:`);
		console.warn(`   npm run feed-upload -- ${feed.name} <arquivos> --batch ${batchId}`);
	} else {
		const current = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
		console.log(current && current.batchId === batchId
			? `\n🎯 Lote ${batchId} agora e o corrente do feed ${feed.name}.`
			: `\n⚠️  Lote ${batchId} ainda NAO e o corrente (confira arquivos faltantes/quarentena).`);
	}
}

main()
	.catch((error) => {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
