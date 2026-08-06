const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../../lib/feeds/catalog');

// Stub minimo: findFirst com filtro por feed/fileName/sha256 e ordenacao.
function makePrismaStub(rows = []) {
	return {
		rows,
		feedArtifact: {
			findFirst: async ({ where, orderBy }) => {
				let found = rows.filter((row) =>
					row.feed === where.feed && row.fileName === where.fileName && row.sha256 === where.sha256);
				if (orderBy?.uploadedAt === 'desc') found = found.sort((a, b) => b.uploadedAt - a.uploadedAt);
				return found[0] || null;
			},
		},
	};
}

const artifact = (over = {}) => ({
	id: 1,
	feed: 'ctp',
	fileName: 'CTPENT_Inventory.csv',
	sha256: 'a'.repeat(64),
	objectKey: 'feeds/ctp/2026/08/x-CTPENT_Inventory.csv',
	sizeBytes: 100,
	uploadedAt: new Date('2026-08-01'),
	status: 'superseded',
	...over,
});

test('encontra artefato com o mesmo conteudo (evita reenviar o arquivo)', async () => {
	const prisma = makePrismaStub([artifact()]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found.objectKey, 'feeds/ctp/2026/08/x-CTPENT_Inventory.csv');
});

test('conteudo diferente, feed diferente ou arquivo diferente nao casam', async () => {
	const prisma = makePrismaStub([artifact()]);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'b'.repeat(64)), null);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'omix', 'CTPENT_Inventory.csv', 'a'.repeat(64)), null);
	assert.strictEqual(await catalog.findArtifactByHash(prisma, 'ctp', 'outro.csv', 'a'.repeat(64)), null);
});

test('com varias versoes do mesmo conteudo, devolve a mais recente', async () => {
	const prisma = makePrismaStub([
		artifact({ id: 1, objectKey: 'antigo', uploadedAt: new Date('2026-07-01') }),
		artifact({ id: 2, objectKey: 'recente', uploadedAt: new Date('2026-08-05') }),
	]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found.objectKey, 'recente');
});

test('artefato em quarentena tambem e encontrado (a decisao de reusar e de quem chama)', async () => {
	const prisma = makePrismaStub([artifact({ status: 'quarantined' })]);
	const found = await catalog.findArtifactByHash(prisma, 'ctp', 'CTPENT_Inventory.csv', 'a'.repeat(64));
	assert.strictEqual(found.status, 'quarantined');
});
