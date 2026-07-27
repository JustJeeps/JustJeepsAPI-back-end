// Watermark compartilhado dos syncs de pedidos (chave em SyncState). O delta
// le/avanca esta marca para buscar so o que mudou; o full reseed tambem grava
// ao terminar para que o "Last sync" da tela de Orders (que le o updatedAt
// desta chave via /api/orders/sync-state) reflita QUALQUER sync bem-sucedido,
// nao apenas o delta.
//
// Recebe o client prisma por parametro (em vez de importar o singleton) para
// permitir testes com stub — o .env local aponta para o Postgres de producao.
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
