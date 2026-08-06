const prisma = require("../prisma");

// Set-based diff engine: staging -> target table in 3 short phases.
//   INSERT  staging rows with no match in the target (ON CONFLICT DO NOTHING)
//   UPDATE  only the rows whose payload changed (IS DISTINCT FROM)
//   STALE   target rows (inside the scope) missing from staging:
//           'delete' | 'markInventoryZero' | 'none'
//
// IMPORTANT (stale 'delete'): OrderProduct.vendor_product_id has an FK with
// ON DELETE CASCADE, so deleting a VendorProduct destroys historical order
// line items. The references are set to NULL before the delete. (The legacy
// full-replace wiped the whole vendor table every day and cascaded without
// mercy.)

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function diffApply({
  target,            // e.g.: 'VendorProduct'
  staging,           // e.g.: 'staging.vp_quadratec'
  keyCols,           // e.g.: ['vendor_id', 'vendor_sku']
  compareCols,       // columns that define "changed"
  insertCols,        // columns inserted on new rows
  scopeWhereSql,     // stale scope in the target, e.g.: `t."vendor_id" = 4`
  staleStrategy = "none",
  setExtraSql = `"updatedAt" = now()`, // applied on the UPDATE of changed rows
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
      throw new Error(`unknown staleStrategy: ${staleStrategy}`);
    }
  }

  return {
    inserted: insertedRows[0].n,
    updated: updatedRows[0].n,
    stale,
  };
}

// Deletes VendorProduct rows without destroying historical line items: since
// OrderProduct.vendor_product_id has an FK with ON DELETE CASCADE, the
// references are set to NULL before the delete. `whereSql` must reference the
// VendorProduct alias `t` (e.g.: `t."vendor_id" = 2 AND ...`). Extracted from
// the stale 'delete' phase so it can be reused by vendor specific sweeps
// (e.g.: Meyer).
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
