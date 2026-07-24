const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Injeta um prisma fake ANTES de carregar o modulo sob teste: o lock so usa
// syncState.upsert/updateMany, entao simulamos o Postgres com uma "linha".
const prismaPath = require.resolve('../../lib/prisma.js');
const fakeRow = { key: 'orders-sync-lock', value: null, lockedUntil: null };
const calls = [];

require.cache[prismaPath] = {
	id: prismaPath,
	filename: prismaPath,
	loaded: true,
	exports: {
		syncState: {
			upsert: async () => fakeRow,
			updateMany: async (args) => {
				calls.push(args);
				const where = args.where || {};
				const now = new Date();
				// acquire: where.OR (livre ou expirado)
				if (where.OR) {
					const free = fakeRow.lockedUntil === null || fakeRow.lockedUntil < now;
					if (!free) return { count: 0 };
					Object.assign(fakeRow, args.data);
					return { count: 1 };
				}
				// renew/release: condicionado ao token (where.value)
				if (fakeRow.value !== where.value) return { count: 0 };
				Object.assign(fakeRow, args.data);
				return { count: 1 };
			},
		},
	},
};

const { acquireOrderSyncLock, releaseOrderSyncLock, orderSyncLockLost } =
	require('../../lib/orderSyncLock.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('acquire pega o lock livre, grava token e lease', async () => {
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, true);
	assert.ok(fakeRow.value, 'token gravado em SyncState.value');
	assert.ok(fakeRow.lockedUntil > new Date(), 'lease no futuro');
	assert.strictEqual(orderSyncLockLost(), false);
	await releaseOrderSyncLock();
	assert.strictEqual(fakeRow.lockedUntil, null, 'release limpa a lease');
});

test('acquire falha quando outro processo detem o lock', async () => {
	fakeRow.value = 'token-de-outro-processo';
	fakeRow.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, false);
	// Nao pode ter mexido no lock alheio
	assert.strictEqual(fakeRow.value, 'token-de-outro-processo');
});

test('acquire assume lock com lease expirada', async () => {
	fakeRow.value = 'token-morto';
	fakeRow.lockedUntil = new Date(Date.now() - 1000);
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, true);
	assert.notStrictEqual(fakeRow.value, 'token-morto', 'novo token assume');
	await releaseOrderSyncLock();
});

test('renovacao mantem a lease enquanto o processo vive', async () => {
	fakeRow.value = null;
	fakeRow.lockedUntil = null;
	assert.strictEqual(await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 20 }), true);
	const leaseInicial = fakeRow.lockedUntil;
	await sleep(60);
	assert.ok(fakeRow.lockedUntil > leaseInicial, 'lease foi estendida pela renovacao');
	assert.strictEqual(orderSyncLockLost(), false);
	await releaseOrderSyncLock();
});

test('perda do lock e detectada e nao derruba o lock do novo dono', async () => {
	fakeRow.value = null;
	fakeRow.lockedUntil = null;
	assert.strictEqual(await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 20 }), true);
	// Outro sync assume (simula lease expirada + takeover): token muda por baixo
	fakeRow.value = 'novo-dono';
	fakeRow.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
	await sleep(60);
	assert.strictEqual(orderSyncLockLost(), true, 'detentor antigo detecta a perda');
	await releaseOrderSyncLock();
	// Release condicionado ao token: lock do novo dono permanece intacto
	assert.strictEqual(fakeRow.value, 'novo-dono');
	assert.ok(fakeRow.lockedUntil > new Date(), 'lease do novo dono preservada');
});
