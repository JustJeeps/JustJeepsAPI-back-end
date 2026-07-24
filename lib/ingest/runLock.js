const prisma = require("../prisma");

// Lock cross-process por lease em cima da tabela SyncState, por feed. Mesmo
// padrao de lib/orderSyncLock.js: advisory locks do Postgres sao por conexao e
// nao sobrevivem ao pool do Prisma; a lease expira sozinha se o detentor morrer
// sem liberar. Usado por feeds com mais de um gatilho de agendamento (ex.: Meyer
// CA tem cron proprio `7 */4 * * *` + slot no seed-all) para impedir duas
// rodadas concorrentes de disputarem a mesma UNLOGGED staging table.
//
// Lease default maior que o do orderSyncLock (30min) porque uma rodada de
// ingestao pode incluir fetch sequencial longo antes de tocar o banco.

function lockKey(feed) {
  return `ingest-lock:${feed}`;
}

async function acquireIngestLock(feed, { leaseMinutes = 60 } = {}) {
  if (!feed) throw new Error("acquireIngestLock requer um feed");
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

async function releaseIngestLock(feed) {
  if (!feed) return;
  await prisma.syncState.updateMany({
    where: { key: lockKey(feed) },
    data: { lockedUntil: null },
  });
}

module.exports = { acquireIngestLock, releaseIngestLock };
