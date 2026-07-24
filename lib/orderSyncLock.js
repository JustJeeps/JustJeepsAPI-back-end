const crypto = require("crypto");
const prisma = require("./prisma");

const LOCK_KEY = "orders-sync-lock";

// Lock cross-process por lease em cima da tabela SyncState. Advisory locks do
// Postgres sao por conexao e nao sobrevivem ao pool do Prisma; a lease expira
// sozinha se o processo detentor morrer sem liberar.
//
// Desde jul/2026 a lease e' CURTA (5min) e renovada a cada 60s enquanto o
// detentor vive: se um deploy/crash matar um sync no meio, os updates de
// ordens voltam sozinhos em <=5min (incidente de 24/jul: cutover do Kamal
// matou um seed-orders-all e o lock ficou preso por quase 1h com lease de 60min).
//
// Posse por token (coluna SyncState.value): renovacao e release so afetam o
// lock se o token ainda for NOSSO. Se a lease expirar com o processo vivo
// (event loop parado >5min) e outro sync assumir, a renovacao detecta a perda
// e `orderSyncLockLost()` vira true — o detentor antigo deve ABORTAR em vez de
// escrever em paralelo (o full reseed faz deleteMany; paralelismo corrompe).
const DEFAULT_LEASE_MINUTES = 5;
const DEFAULT_RENEW_INTERVAL_MS = 60 * 1000;

// Estado do detentor NESTE processo (cada seed roda em processo proprio).
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
        // Outro sync assumiu (nossa lease expirou). NAO derrubar o lock dele;
        // sinalizar para o nosso caller abortar.
        lockLost = true;
        stopRenewal();
      }
    } catch (_) {
      // Falha transitoria de DB: nao marcar como perdido — a lease de 5min da
      // ~5 tentativas de renovacao antes de expirar; as escritas do proprio
      // sync falhariam junto se o banco estivesse realmente fora.
    }
  }, renewIntervalMs);
  // Nao segurar o processo vivo so pela renovacao.
  if (typeof renewTimer.unref === "function") renewTimer.unref();

  return true;
};

// True se ESTE processo adquiriu o lock e depois o perdeu para outro sync.
// Callers de longa duracao devem checar entre paginas/batches e abortar.
const orderSyncLockLost = () => lockLost;

const releaseOrderSyncLock = async () => {
  stopRenewal();
  if (!holderToken) return;
  const token = holderToken;
  holderToken = null;
  // Condicionado ao token: se outro sync ja assumiu, nao solta o lock DELE.
  await prisma.syncState.updateMany({
    where: { key: LOCK_KEY, value: token },
    data: { lockedUntil: null },
  });
};

module.exports = { acquireOrderSyncLock, releaseOrderSyncLock, orderSyncLockLost };
