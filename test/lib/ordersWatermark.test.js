const test = require('node:test');
const assert = require('node:assert');

const { WATERMARK_KEY, readWatermark, saveWatermark } = require('../../lib/ordersWatermark.js');

// O helper recebe o prisma por parametro, entao o stub entra direto — nenhum
// contato com o Postgres (o .env local aponta para producao).
const makePrismaStub = () => {
	const calls = { findUnique: [], upsert: [] };
	let row = null;
	return {
		calls,
		getRow: () => row,
		setRow: (value) => { row = { key: WATERMARK_KEY, value }; },
		syncState: {
			findUnique: async (args) => {
				calls.findUnique.push(args);
				return row;
			},
			upsert: async (args) => {
				calls.upsert.push(args);
				row = { key: args.where.key, value: row ? args.update.value : args.create.value };
				return row;
			},
		},
	};
};

test('WATERMARK_KEY e a mesma chave lida pelo /api/orders/sync-state', () => {
	assert.strictEqual(WATERMARK_KEY, 'orders-delta-watermark');
});

test('readWatermark retorna null sem estado gravado', async () => {
	const prisma = makePrismaStub();
	assert.strictEqual(await readWatermark(prisma), null);
	assert.deepStrictEqual(prisma.calls.findUnique[0], { where: { key: WATERMARK_KEY } });
});

test('readWatermark retorna o valor gravado', async () => {
	const prisma = makePrismaStub();
	prisma.setRow('2026-07-27 18:00:00');
	assert.strictEqual(await readWatermark(prisma), '2026-07-27 18:00:00');
});

test('saveWatermark cria a linha com chave e valor corretos', async () => {
	const prisma = makePrismaStub();
	await saveWatermark(prisma, '2026-07-27 18:05:00');
	assert.deepStrictEqual(prisma.calls.upsert[0], {
		where: { key: WATERMARK_KEY },
		create: { key: WATERMARK_KEY, value: '2026-07-27 18:05:00' },
		update: { value: '2026-07-27 18:05:00' },
	});
	assert.strictEqual(prisma.getRow().value, '2026-07-27 18:05:00');
});

test('saveWatermark sobrescreve valor existente (upsert)', async () => {
	const prisma = makePrismaStub();
	prisma.setRow('2026-07-27 17:00:00');
	await saveWatermark(prisma, '2026-07-27 18:10:00');
	assert.strictEqual(prisma.getRow().value, '2026-07-27 18:10:00');
	assert.strictEqual(await readWatermark(prisma), '2026-07-27 18:10:00');
});
