// Watermark shared by the order syncs (a key in SyncState). The delta reads and
// advances this mark to fetch only what changed; the full reseed also writes it
// when it finishes so that the "Last sync" on the Orders screen (which reads the
// updatedAt of this key via /api/orders/sync-state) reflects ANY successful
// sync, not only the delta.
//
// Takes the prisma client as a parameter (instead of importing the singleton)
// to allow testing with a stub: the local .env points at the production
// Postgres.
const WATERMARK_KEY = "orders-delta-watermark";

const readWatermark = async (prisma) => {
  const state = await prisma.syncState.findUnique({ where: { key: WATERMARK_KEY } });
  return state?.value || null;
};

const saveWatermark = async (prisma, value) => {
  await prisma.syncState.upsert({
    where: { key: WATERMARK_KEY },
    create: { key: WATERMARK_KEY, value },
    update: { value },
  });
};

module.exports = { WATERMARK_KEY, readWatermark, saveWatermark };
