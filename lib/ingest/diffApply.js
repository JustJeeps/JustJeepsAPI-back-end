const prisma = require("../prisma");

// Motor de diff set-based: staging -> tabela alvo em 3 fases curtas.
//   INSERT  linhas do staging sem match no alvo (ON CONFLICT DO NOTHING)
//   UPDATE  apenas linhas cujo payload mudou (IS DISTINCT FROM)
//   STALE   linhas do alvo (no escopo) ausentes do staging:
//           'delete' | 'markInventoryZero' | 'none'
//
// IMPORTANTE (stale 'delete'): OrderProduct.vendor_product_id tem FK com
// ON DELETE CASCADE — deletar VendorProduct destroi line items historicos de
// pedidos. Antes de deletar, as referencias sao ANULADAS. (O full-replace
// legado deletava a tabela inteira do vendor todo dia e cascateava sem dó.)

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function diffApply({
  target,            // ex.: 'VendorProduct'
  staging,           // ex.: 'staging.vp_quadratec'
  keyCols,           // ex.: ['vendor_id', 'vendor_sku']
  compareCols,       // colunas que definem "mudou"
  insertCols,        // colunas inseridas em linhas novas
  scopeWhereSql,     // escopo do stale no alvo, ex.: `t."vendor_id" = 4`
  staleStrategy = "none",
  setExtraSql = `"updatedAt" = now()`, // aplicado no UPDATE de linhas mudadas
}) {
  const t = quoteIdent(target);
  const joinOn = keyCols.map((c) => `t.${quoteIdent(c)} = s.${quoteIdent(c)}`).join(" AND ");
  const changed = compareCols.map((c) => `t.${quoteIdent(c)} IS DISTINCT FROM s.${quoteIdent(c)}`).join(" OR ");
  const insertColSql = insertCols.map(quoteIdent).join(", ");
  const selectColSql = insertCols.map((c) => `s.${quoteIdent(c)}`).join(", ");
  const conflictSql = keyCols.map(quoteIdent).join(", ");
  const setSql = compareCols.map((c) => `${quoteIdent(c)} = s.${quoteIdent(c)}`).join(", ");

  const insertedRows = await prisma.$queryRawUnsafe(`
    WITH ins AS (
      INSERT INTO ${t} (${insertColSql})
      SELECT ${selectColSql} FROM ${staging} s
      ON CONFLICT (${conflictSql}) DO NOTHING
      RETURNING 1
    ) SELECT count(*)::int AS n FROM ins
  `);

  const updatedRows = await prisma.$queryRawUnsafe(`
    WITH upd AS (
      UPDATE ${t} t
         SET ${setSql}${setExtraSql ? `, ${setExtraSql}` : ""}
        FROM ${staging} s
       WHERE ${joinOn}
         AND (${changed})
      RETURNING 1
    ) SELECT count(*)::int AS n FROM upd
  `);

  let stale = 0;
  if (staleStrategy !== "none") {
    const staleWhere = `${scopeWhereSql} AND NOT EXISTS (SELECT 1 FROM ${staging} s WHERE ${joinOn})`;

    if (staleStrategy === "delete") {
      stale = await deleteVendorProductsSafely(staleWhere);
    } else if (staleStrategy === "markInventoryZero") {
      const markedRows = await prisma.$queryRawUnsafe(`
        WITH mrk AS (
          UPDATE ${t} t
             SET "vendor_inventory" = 0${setExtraSql ? `, ${setExtraSql}` : ""}
           WHERE ${staleWhere}
             AND t."vendor_inventory" IS DISTINCT FROM 0
          RETURNING 1
        ) SELECT count(*)::int AS n FROM mrk
      `);
      stale = markedRows[0].n;
    } else {
      throw new Error(`staleStrategy desconhecida: ${staleStrategy}`);
    }
  }

  return {
    inserted: insertedRows[0].n,
    updated: updatedRows[0].n,
    stale,
  };
}

// Deleta linhas de VendorProduct sem destruir line items historicos: como
// OrderProduct.vendor_product_id tem FK ON DELETE CASCADE, as referencias sao
// ANULADAS antes do delete. `whereSql` deve referenciar o alias `t` da
// VendorProduct (ex.: `t."vendor_id" = 2 AND ...`). Extraido da fase stale
// 'delete' para ser reusado por sweeps especificos de vendor (ex.: Meyer).
async function deleteVendorProductsSafely(whereSql) {
  const t = quoteIdent("VendorProduct");
  await prisma.$executeRawUnsafe(`
    UPDATE "OrderProduct" op SET vendor_product_id = NULL
    WHERE op.vendor_product_id IN (SELECT t.id FROM ${t} t WHERE ${whereSql})
  `);
  const deletedRows = await prisma.$queryRawUnsafe(`
    WITH del AS (
      DELETE FROM ${t} t2 USING (SELECT t.id FROM ${t} t WHERE ${whereSql}) victims
      WHERE t2.id = victims.id
      RETURNING 1
    ) SELECT count(*)::int AS n FROM del
  `);
  return deletedRows[0].n;
}

module.exports = { diffApply, deleteVendorProductsSafely };
