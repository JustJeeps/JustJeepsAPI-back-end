const prisma = require("../prisma");

// Cross-process lease lock on top of the SyncState table, one per feed. Same
// pattern as lib/orderSyncLock.js: Postgres advisory locks are per connection
// and do not survive the Prisma pool; the lease expires on its own if the holder
// dies without releasing it. Used by feeds with more than one scheduling trigger
// (for example Meyer CA has its own cron `7 */4 * * *` plus a slot in seed-all)
// to prevent two concurrent runs from fighting over the same UNLOGGED staging
// table.
//
// The default lease is longer than the orderSyncLock one (30min) because an
// ingestion run can include a long sequential fetch before it touches the
// database.

function lockKey(feed) {
  return `ingest-lock:${feed}`;
}

async function acquireIngestLock(feed, { leaseMinutes = 60 } = {}) {
  if (!feed) throw new Error("acquireIngestLock requires a feed");
  const key = lockKey(feed);

  await prisma.syncState.upsert({
    where: { key },
    create: { key },
    update: {},
  });

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMinutes * 60 * 1000);
  const result = await prisma.syncState.updateMany({
    where: {
      key,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: leaseUntil },
  });

  return result.count === 1;
}

// Renova o lease do DONO atual (chamar so quem adquiriu). Permite leases
// curtos: um holder vivo renova a cada lote, e um holder morto libera o lock
// em minutos em vez de esperar o lease longo inteiro (o sync de reviews usa
// lease de 5min renovado por lote, para retomar rapido depois de um crash).
async function renewIngestLock(feed, { leaseMinutes = 60 } = {}) {
  if (!feed) return;
  await prisma.syncState.updateMany({
    where: { key: lockKey(feed) },
    data: { lockedUntil: new Date(Date.now() + leaseMinutes * 60 * 1000) },
  });
}

async function releaseIngestLock(feed) {
  if (!feed) return;
  await prisma.syncState.updateMany({
    where: { key: lockKey(feed) },
    data: { lockedUntil: null },
  });
}

module.exports = { acquireIngestLock, renewIngestLock, releaseIngestLock };
