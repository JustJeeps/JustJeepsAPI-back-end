const crypto = require("crypto");
const prisma = require("./prisma");

const LOCK_KEY = "orders-sync-lock";

// Cross-process lease lock on top of the SyncState table. Postgres advisory
// locks are per connection and do not survive the Prisma pool; this lease
// expires on its own if the holder process dies without releasing it.
//
// Since July 2026 the lease is SHORT (5min) and renewed every 60s while the
// holder is alive: if a deploy or a crash kills a sync midway, order updates
// come back on their own within 5min (July 24 incident: the Kamal cutover
// killed a seed-orders-all and the lock stayed stuck for almost 1h with a
// 60min lease).
//
// Ownership by token (SyncState.value column): renewal and release only touch
// the lock while the token is still OURS. If the lease expires with the process
// still alive (event loop blocked for more than 5min) and another sync takes
// over, the renewal detects the loss and `orderSyncLockLost()` turns true: the
// old holder must ABORT instead of writing in parallel (the full reseed does a
// deleteMany, so parallelism corrupts the data).
const DEFAULT_LEASE_MINUTES = 5;
const DEFAULT_RENEW_INTERVAL_MS = 60 * 1000;

// Holder state for THIS process (each seed runs in its own process).
let holderToken = null;
let renewTimer = null;
let lockLost = false;

function stopRenewal() {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
}

const acquireOrderSyncLock = async ({
  leaseMinutes = DEFAULT_LEASE_MINUTES,
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
} = {}) => {
  await prisma.syncState.upsert({
    where: { key: LOCK_KEY },
    create: { key: LOCK_KEY },
    update: {},
  });

  const token = crypto.randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMinutes * 60 * 1000);
  const result = await prisma.syncState.updateMany({
    where: {
      key: LOCK_KEY,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: leaseUntil, value: token },
  });

  if (result.count !== 1) return false;

  holderToken = token;
  lockLost = false;
  stopRenewal();
  renewTimer = setInterval(async () => {
    try {
      const renewed = await prisma.syncState.updateMany({
        where: { key: LOCK_KEY, value: holderToken },
        data: { lockedUntil: new Date(Date.now() + leaseMinutes * 60 * 1000) },
      });
      if (renewed.count !== 1) {
        // Another sync took over (our lease expired). Do NOT drop their lock,
        // just signal our caller to abort.
        lockLost = true;
        stopRenewal();
      }
    } catch (_) {
      // Transient DB failure: do not mark the lock as lost. The 5min lease
      // allows about 5 renewal attempts before it expires, and the sync's own
      // writes would fail too if the database were really down.
    }
  }, renewIntervalMs);
  // Do not keep the process alive just for the renewal timer.
  if (typeof renewTimer.unref === "function") renewTimer.unref();

  return true;
};

// True if THIS process acquired the lock and later lost it to another sync.
// Long running callers should check this between pages/batches and abort.
const orderSyncLockLost = () => lockLost;

const releaseOrderSyncLock = async () => {
  stopRenewal();
  if (!holderToken) return;
  const token = holderToken;
  holderToken = null;
  // Conditioned on the token: if another sync already took over, do not
  // release THEIR lock.
  await prisma.syncState.updateMany({
    where: { key: LOCK_KEY, value: token },
    data: { lockedUntil: null },
  });
};

module.exports = { acquireOrderSyncLock, releaseOrderSyncLock, orderSyncLockLost };
