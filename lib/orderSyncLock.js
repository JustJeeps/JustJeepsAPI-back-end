const prisma = require("./prisma");

const LOCK_KEY = "orders-sync-lock";

// Lock cross-process por lease em cima da tabela SyncState. Advisory locks do
// Postgres sao por conexao e nao sobrevivem ao pool do Prisma; a lease expira
// sozinha se o processo detentor morrer sem liberar.
const acquireOrderSyncLock = async ({ leaseMinutes = 30 } = {}) => {
  await prisma.syncState.upsert({
    where: { key: LOCK_KEY },
    create: { key: LOCK_KEY },
    update: {},
  });

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMinutes * 60 * 1000);
  const result = await prisma.syncState.updateMany({
    where: {
      key: LOCK_KEY,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: leaseUntil },
  });

  return result.count === 1;
};

const releaseOrderSyncLock = async () => {
  await prisma.syncState.updateMany({
    where: { key: LOCK_KEY },
    data: { lockedUntil: null },
  });
};

module.exports = { acquireOrderSyncLock, releaseOrderSyncLock };
