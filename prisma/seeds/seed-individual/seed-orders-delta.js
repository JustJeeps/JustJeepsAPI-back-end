const prisma = require("../../../lib/prisma");
const getOrdersUpdatedSince = require("../api-calls/magento-ordersUpdatedSince.js");
const { processOrder } = require("./seed-orders.js");
const { acquireOrderSyncLock, releaseOrderSyncLock, orderSyncLockLost } = require("../../../lib/orderSyncLock.js");
const { readWatermark, saveWatermark } = require("../../../lib/ordersWatermark.js");

const PAGE_SIZE = Number(process.env.SEED_ORDERS_DELTA_PAGE_SIZE) || 100;
const MAX_PAGES = Number(process.env.SEED_ORDERS_DELTA_MAX_PAGES) || 50;
// Janela de sobreposicao: reprocessa alguns minutos antes do watermark para
// absorver clock skew e updates na borda. Upserts sao idempotentes.
const OVERLAP_MINUTES = Number(process.env.SEED_ORDERS_DELTA_OVERLAP_MINUTES) || 5;
const INITIAL_LOOKBACK_HOURS = Number(process.env.SEED_ORDERS_DELTA_LOOKBACK_HOURS) || 48;
const CONCURRENCY = Number(process.env.SEED_ORDERS_DELTA_CONCURRENCY) || 5;

// Magento usa "YYYY-MM-DD HH:MM:SS" em UTC — comparacao lexicografica desse
// formato equivale a comparacao cronologica.
const toMagentoUtc = (date) => date.toISOString().slice(0, 19).replace("T", " ");

const seedOrdersDelta = async (options = {}) => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const startedAtMs = Date.now();

  // Lease curta com renovacao automatica (ver lib/orderSyncLock.js): se este
  // processo morrer no meio, o lock libera sozinho em <=5min.
  const locked = await acquireOrderSyncLock();
  if (!locked) {
    // Outro sync (delta, seed-orders-all etc.) esta rodando: pular e uma
    // condicao normal para o cron, nao uma falha — sai com codigo 0.
    console.log("[seed-orders-delta] Skipped: another order sync holds the lock.");
    if (onProgress) {
      onProgress({
        total: 0,
        processed: 0,
        status: "error",
        error: "Another order sync is already running",
      });
    }
    return { skipped: true };
  }

  try {
    const watermark = await readWatermark(prisma);
    const scanStartUtc = toMagentoUtc(new Date());
    let sinceUtc;
    if (watermark) {
      const overlapStart = new Date(
        new Date(`${watermark.replace(" ", "T")}Z`).getTime() - OVERLAP_MINUTES * 60 * 1000
      );
      sinceUtc = toMagentoUtc(overlapStart);
    } else {
      sinceUtc = toMagentoUtc(new Date(Date.now() - INITIAL_LOOKBACK_HOURS * 60 * 60 * 1000));
    }
    console.log(`[seed-orders-delta] Start: updated_at >= ${sinceUtc} (watermark: ${watermark || "none"})`);

    let processed = 0;
    let failed = 0;
    let totalCount = null;
    let maxUpdatedAt = null;

    for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage++) {
      // Perdemos o lock (lease expirou com o processo travado e outro sync
      // assumiu)? Abortar sem avancar watermark — nunca escrever em paralelo.
      if (orderSyncLockLost()) {
        throw new Error("Order sync lock lost mid-run; aborting to avoid concurrent writes");
      }
      const data = await getOrdersUpdatedSince(sinceUtc, { pageSize: PAGE_SIZE, currentPage });
      // Resposta sem items[] (ex.: HTML de WAF/proxy com status 200) nao pode
      // ser tratada como "nada mudou" — senao o watermark avancaria por cima
      // de pedidos nao sincronizados.
      if (!data || !Array.isArray(data.items)) {
        throw new Error("Unexpected Magento response shape (items missing)");
      }
      const items = data.items;
      if (totalCount === null) {
        totalCount = Number.isFinite(Number(data?.total_count)) ? Number(data.total_count) : items.length;
        if (onProgress) {
          onProgress({ total: totalCount, processed: 0, status: "running" });
        }
      }
      if (!items.length) break;

      for (let i = 0; i < items.length; i += CONCURRENCY) {
        const batch = items.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (orderData) => {
            try {
              await processOrder(orderData);
              processed += 1;
            } catch (error) {
              failed += 1;
              console.error(`[seed-orders-delta] Error processing order ${orderData?.entity_id}:`, error);
            }
          })
        );
        if (onProgress) {
          onProgress({ total: totalCount, processed, status: "running" });
        }
      }

      for (const orderData of items) {
        const updatedAt = orderData?.updated_at;
        if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
          maxUpdatedAt = updatedAt;
        }
      }

      if (items.length < PAGE_SIZE) break;
      if (currentPage === MAX_PAGES) {
        console.warn(`[seed-orders-delta] MAX_PAGES (${MAX_PAGES}) reached with pages still pending; remainder syncs next run.`);
      }
    }

    // So avanca o watermark quando nada falhou: pedidos com erro continuam
    // dentro da janela e sao retentados na proxima rodada.
    if (failed === 0) {
      await saveWatermark(prisma, maxUpdatedAt || scanStartUtc);
    } else {
      console.warn(`[seed-orders-delta] ${failed} order(s) failed; watermark not advanced (will retry next run).`);
    }

    const durationMs = Date.now() - startedAtMs;
    console.log(
      `[seed-orders-delta] Done in ${durationMs}ms: ${processed} processed, ${failed} failed, total_count=${totalCount ?? 0}, new watermark=${failed === 0 ? maxUpdatedAt || scanStartUtc : watermark || "none"}`
    );

    if (onProgress) {
      onProgress({ total: totalCount ?? 0, processed, status: "done" });
    }

    return { processed, failed, totalCount: totalCount ?? 0 };
  } catch (error) {
    console.error("[seed-orders-delta] Error during delta sync:", error);
    if (onProgress) {
      onProgress({
        total: 0,
        processed: 0,
        status: "error",
        error: error?.message || "Delta sync failed",
      });
    }
    throw error;
  } finally {
    await releaseOrderSyncLock();
  }
};

module.exports = seedOrdersDelta;

// Executa apenas quando rodado diretamente (npm run seed-orders-delta / cron).
// Exit code != 0 em falha para o cron runner notificar.
if (require.main === module) {
  seedOrdersDelta()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
