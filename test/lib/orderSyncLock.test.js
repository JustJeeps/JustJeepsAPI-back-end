const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Injects a fake prisma BEFORE loading the module under test: the lock only
// uses syncState.upsert/updateMany, so we simulate Postgres with a single "row".
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
				// acquire: where.OR (free or expired)
				if (where.OR) {
					const free = fakeRow.lockedUntil === null || fakeRow.lockedUntil < now;
					if (!free) return { count: 0 };
					Object.assign(fakeRow, args.data);
					return { count: 1 };
				}
				// renew/release: conditioned on the token (where.value)
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

test('acquire takes the free lock and writes token and lease', async () => {
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, true);
	assert.ok(fakeRow.value, 'token written to SyncState.value');
	assert.ok(fakeRow.lockedUntil > new Date(), 'lease in the future');
	assert.strictEqual(orderSyncLockLost(), false);
	await releaseOrderSyncLock();
	assert.strictEqual(fakeRow.lockedUntil, null, 'release clears the lease');
});

test('acquire fails when another process holds the lock', async () => {
	fakeRow.value = 'another-process-token';
	fakeRow.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, false);
	// Must not have touched someone else's lock
	assert.strictEqual(fakeRow.value, 'another-process-token');
});

test('acquire takes over a lock with an expired lease', async () => {
	fakeRow.value = 'dead-token';
	fakeRow.lockedUntil = new Date(Date.now() - 1000);
	const ok = await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 3600000 });
	assert.strictEqual(ok, true);
	assert.notStrictEqual(fakeRow.value, 'dead-token', 'a new token takes over');
	await releaseOrderSyncLock();
});

test('renewal keeps the lease alive while the process lives', async () => {
	fakeRow.value = null;
	fakeRow.lockedUntil = null;
	assert.strictEqual(await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 20 }), true);
	const leaseInicial = fakeRow.lockedUntil;
	await sleep(60);
	assert.ok(fakeRow.lockedUntil > leaseInicial, 'lease was extended by the renewal');
	assert.strictEqual(orderSyncLockLost(), false);
	await releaseOrderSyncLock();
});

test('lock loss is detected and does not drop the new owner lock', async () => {
	fakeRow.value = null;
	fakeRow.lockedUntil = null;
	assert.strictEqual(await acquireOrderSyncLock({ leaseMinutes: 5, renewIntervalMs: 20 }), true);
	// Another sync takes over (simulates expired lease plus takeover): the token
	// changes underneath us
	fakeRow.value = 'new-owner';
	fakeRow.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
	await sleep(60);
	assert.strictEqual(orderSyncLockLost(), true, 'the old holder detects the loss');
	await releaseOrderSyncLock();
	// Release conditioned on the token: the new owner lock stays intact
	assert.strictEqual(fakeRow.value, 'new-owner');
	assert.ok(fakeRow.lockedUntil > new Date(), 'the new owner lease is preserved');
});
