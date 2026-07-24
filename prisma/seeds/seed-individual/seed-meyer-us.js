const crypto = require("crypto");
const meyerApiUs = require("../api-calls/meyer-api-us.js");

const prisma = require("../../../lib/prisma");
const { ensureStagingTable, insertBatch, closePool } = require("../../../lib/ingest/stageTable");
const { diffApply, deleteVendorProductsSafely } = require("../../../lib/ingest/diffApply");
const { startRun, isUnchanged } = require("../../../lib/ingest/ingestRun");
const { acquireIngestLock, releaseIngestLock } = require("../../../lib/ingest/runLock");

function safeFloat(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isBajaBrand(brandName) {
  return String(brandName || "").trim().toLowerCase() === "baja designs";
}

function normalizeBajaVendorPart(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  const prefixedDashed = raw.match(/^(?:BAJ|BAJA\s*DESIGNS)[-\s]?(\d{2})-(\d+)$/);
  if (prefixedDashed) {
    return `${prefixedDashed[1]}-${prefixedDashed[2]}`;
  }

  const prefixed = raw.match(/^BAJ[-\s]?(\d+)$/);
  if (prefixed) {
    const digits = prefixed[1];
    if (digits.length < 5) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  const dashed = raw.match(/^(\d{2})-(\d+)$/);
  if (dashed) return `${dashed[1]}-${dashed[2]}`;

  const compact = raw.match(/^(\d+)$/);
  if (compact) {
    const digits = compact[1];
    if (digits.length < 5) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  return null;
}

function toBajaVendorPart(value) {
  const normalized = normalizeBajaVendorPart(value);
  if (!normalized) return null;
  return normalized;
}

function resolveMeyerProductSku(map, itemNumber) {
  const raw = String(itemNumber || "").trim();
  if (!raw) return null;
  if (map.has(raw)) return map.get(raw);

  const normalized = normalizeBajaVendorPart(raw);
  if (normalized && map.has(normalized)) return map.get(normalized);

  return null;
}

function shouldRemoveMeyerVendor(item) {
  const partStatus = String(item?.PartStatus || "").trim().toLowerCase();
  const qtyAvailable = safeFloat(item?.QtyAvailable);
  return partStatus === "discontinued" && qtyAvailable === 0;
}

function escapeSqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function buildValuesSql(rows) {
  return rows
    .map((row) => {
      const vendorId = Number(row.vendor_id);
      const vendorSku = `'${escapeSqlString(row.vendor_sku)}'`;
      const productSku = `'${escapeSqlString(row.product_sku)}'`;

      const costUsd = row.vendor_cost_usd === null ? "NULL" : Number(row.vendor_cost_usd);
      const inv = row.vendor_inventory === null ? "NULL" : Number(row.vendor_inventory);

      const partStatus =
        row.partStatus_meyer === null || row.partStatus_meyer === undefined || row.partStatus_meyer === ""
          ? "NULL"
          : `'${escapeSqlString(row.partStatus_meyer)}'`;

      const len = row.meyer_length === null ? "NULL" : Number(row.meyer_length);
      const wid = row.meyer_width === null ? "NULL" : Number(row.meyer_width);
      const hei = row.meyer_height === null ? "NULL" : Number(row.meyer_height);
      const wgt = row.meyer_weight === null ? "NULL" : Number(row.meyer_weight);

      return `(${vendorId},${vendorSku},${productSku},${costUsd},${inv},${partStatus},${len},${wid},${hei},${wgt})`;
    })
    .join(",\n");
}

// seed Meyer US products
const seedMeyerUsVendorProducts = async () => {
  const seedStartedAt = Date.now();
  try {
    console.time("seed-meyer-us total");
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let vendorProductRemovedCount = 0;
    const batchSize = Number(process.env.SEED_MEYER_DB_BATCH_SIZE || 500);

    // Call MeyerCost US and get the processed responses
    const vendorProductsData = await meyerApiUs();

    const products = await prisma.product.findMany({
      where: {
        status: 1,
        meyer_code: { not: "" },
      },
      select: {
        sku: true,
        meyer_code: true,
        brand_name: true,
      },
    });

    const meyerToProductSku = new Map();
    for (const product of products) {
      if (product.meyer_code) meyerToProductSku.set(product.meyer_code, product.sku);

      if (isBajaBrand(product.brand_name)) {
        const bajaFallbackCode = toBajaVendorPart(product.sku) || toBajaVendorPart(product.meyer_code);
        if (bajaFallbackCode && !meyerToProductSku.has(bajaFallbackCode)) {
          meyerToProductSku.set(bajaFallbackCode, product.sku);
        }
      }
    }

    const flushDbBatch = async (rows) => {
      if (!rows.length) return { inserted: 0, updated: 0, ms: 0 };

      const valuesSql = buildValuesSql(rows);

      const sql = `
WITH incoming(vendor_id, vendor_sku, product_sku, vendor_cost_usd, vendor_inventory, partstatus_meyer, meyer_length, meyer_width, meyer_height, meyer_weight) AS (
  VALUES
  ${valuesSql}
),
updated_vp AS (
  UPDATE "VendorProduct" vp
  SET
    vendor_cost_usd = i.vendor_cost_usd,
    vendor_inventory = i.vendor_inventory,
    "partStatus_meyer" = i.partstatus_meyer
  FROM incoming i
  WHERE vp.vendor_id = i.vendor_id
    AND vp.vendor_sku = i.vendor_sku
  RETURNING vp.id
),
inserted_vp AS (
  INSERT INTO "VendorProduct"(product_sku, vendor_id, vendor_sku, vendor_cost, vendor_cost_usd, vendor_inventory, "partStatus_meyer")
  SELECT
    i.product_sku,
    i.vendor_id,
    i.vendor_sku,
    i.vendor_cost_usd,
    i.vendor_cost_usd,
    i.vendor_inventory,
    i.partstatus_meyer
  FROM incoming i
  LEFT JOIN "VendorProduct" vp
    ON vp.vendor_id = i.vendor_id
   AND vp.vendor_sku = i.vendor_sku
  WHERE vp.id IS NULL
  RETURNING id
),
updated_p AS (
  UPDATE "Product" p
  SET
    "partStatus_meyer" = i.partstatus_meyer,
    meyer_length = i.meyer_length,
    meyer_width = i.meyer_width,
    meyer_height = i.meyer_height,
    meyer_weight = i.meyer_weight
  FROM incoming i
  WHERE p.sku = i.product_sku
  RETURNING p.sku
)
SELECT
  (SELECT COUNT(*) FROM inserted_vp) AS inserted_count,
  (SELECT COUNT(*) FROM updated_vp) AS updated_count,
  (SELECT COUNT(*) FROM updated_p) AS updated_products_count;
`;

      const t0 = Date.now();

      const res = await prisma.$transaction(async (tx) => {
        const out = await tx.$queryRawUnsafe(sql);
        return out?.[0] || { inserted_count: 0, updated_count: 0, updated_products_count: 0 };
      });

      const ms = Date.now() - t0;

      return {
        inserted: Number(res.inserted_count || 0),
        updated: Number(res.updated_count || 0),
        ms,
      };
    };

    const flushDeleteBatch = async (productSkus) => {
      if (!productSkus.length) return 0;

      const res = await prisma.vendorProduct.deleteMany({
        where: {
          vendor_id: 2,
          product_sku: { in: productSkus },
        },
      });

      return Number(res?.count || 0);
    };

    let dbBuffer = [];
    const deleteSkuSet = new Set();

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of vendorProductsData) {
      try {
        if (!data || data.statusCode || !Array.isArray(data) || !data[0]) {
          continue;
        }

        const item = data[0];
        const productSku = resolveMeyerProductSku(meyerToProductSku, item.ItemNumber);
        if (!productSku) {
          console.error(`Product not found for meyer_code: ${item.ItemNumber}`);
          continue;
        }

        if (shouldRemoveMeyerVendor(item)) {
          deleteSkuSet.add(productSku);
          dbBuffer = dbBuffer.filter((row) => row.product_sku !== productSku);
          continue;
        }

        const vendorProductData = {
          product_sku: productSku,
          vendor_id: 2,
          vendor_sku: item.ItemNumber,
          vendor_cost_usd: safeFloat(item.CustomerPrice),
          vendor_inventory: safeFloat(item.QtyAvailable),
          partStatus_meyer: item.PartStatus,
          meyer_length: safeFloat(item.Length),
          meyer_width: safeFloat(item.Width),
          meyer_height: safeFloat(item.Height),
          meyer_weight: safeFloat(item.Weight),
        };

        if (vendorProductData.vendor_cost_usd === null) {
          continue;
        }

        dbBuffer.push(vendorProductData);

        if (dbBuffer.length >= batchSize) {
          const { inserted, updated, ms } = await flushDbBatch(dbBuffer);
          vendorProductCreatedCount += inserted;
          vendorProductUpdatedCount += updated;
          console.log(
            `DB batch flush: inserted=${inserted} updated=${updated} batchSize=${dbBuffer.length} flushMs=${ms}`
          );
          dbBuffer = [];
        }
      } catch (error) {
        console.error("Error processing vendor_sku:", error);
      }
    }

    if (dbBuffer.length) {
      const { inserted, updated, ms } = await flushDbBatch(dbBuffer);
      vendorProductCreatedCount += inserted;
      vendorProductUpdatedCount += updated;
      console.log(
        `Final DB batch flush: inserted=${inserted} updated=${updated} batchSize=${dbBuffer.length} flushMs=${ms}`
      );
      dbBuffer = [];
    }

    if (deleteSkuSet.size) {
      const deleteSkus = Array.from(deleteSkuSet);
      for (let i = 0; i < deleteSkus.length; i += batchSize) {
        const skuBatch = deleteSkus.slice(i, i + batchSize);
        const deleted = await flushDeleteBatch(skuBatch);
        vendorProductRemovedCount += deleted;
      }
    }

    console.log(`Meyer US vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}
      Total vendor products removed (discontinued + zero qty): ${vendorProductRemovedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from Meyer US:", error);
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-meyer-us total");
    const mins = ((Date.now() - seedStartedAt) / 60000).toFixed(2);
    console.log(`seed-meyer-us finished in ${mins} minutes.`);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Pipeline stage+diff (jul/2026). Migra o Meyer US para o padrao de lib/ingest:
// escreve so o delta (via IS DISTINCT FROM) em vez de upsert cego + reescrita da
// Product inteira a cada batch. staleStrategy 'none': ausencia do feed NUNCA
// deleta — CA e US compartilham vendor_id=2, e delecao aqui e' so por
// descontinuado (predicado positivo), nunca por ausencia. O fetch segue
// sequencial (rate limit do Meyer), entao o runtime nao muda; o ganho e'
// reducao de escrita + proveniencia (IngestRun) + guard de falha silenciosa.
// Rollback operacional:  MEYER_US_PIPELINE=legacy npm run seed-meyer-us
const FEED = "meyer-us";
const VENDOR_ID = 2;
const STAGING_TABLE = "vp_meyer_us";
const BATCH_SIZE = Number(process.env.SEED_MEYER_DB_BATCH_SIZE || 500);
const MAX_FAILED_RATIO = Number(process.env.MEYER_MAX_FAILED_RATIO || 0.1);
const LEASE_MINUTES = Number(process.env.MEYER_LOCK_LEASE_MIN || 30);

const STAGING_DDL = `
  product_sku TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  vendor_sku TEXT NOT NULL,
  vendor_cost DOUBLE PRECISION NOT NULL,
  vendor_cost_usd DOUBLE PRECISION NOT NULL,
  vendor_inventory DOUBLE PRECISION,
  "partStatus_meyer" TEXT,
  meyer_length DOUBLE PRECISION,
  meyer_width DOUBLE PRECISION,
  meyer_height DOUBLE PRECISION,
  meyer_weight DOUBLE PRECISION
`;
// Todas as colunas da staging table (inclui meyer_* que sao da Product, usadas
// so pelo UPDATE companheiro — NAO existem na VendorProduct).
const STAGING_COLS = [
  "product_sku", "vendor_id", "vendor_sku", "vendor_cost", "vendor_cost_usd",
  "vendor_inventory", "partStatus_meyer",
  "meyer_length", "meyer_width", "meyer_height", "meyer_weight",
];
// Subconjunto que EXISTE na VendorProduct — usado no INSERT do diffApply. Sem os
// meyer_* (senao o INSERT referenciaria colunas inexistentes na VendorProduct).
const VP_INSERT_COLS = [
  "product_sku", "vendor_id", "vendor_sku", "vendor_cost", "vendor_cost_usd",
  "vendor_inventory", "partStatus_meyer",
];

// SKUs protegidos de delecao por descontinuado (decisao de negocio). Espelha o
// seed-meyer.js (CA): default + SEED_MEYER_KEEP_DISCONTINUED_ZERO_SKUS. No US o
// legado nao honrava a keep-list; passar a honrar so PREVINE delecao (mais
// seguro) e alinha CA/US.
function parseKeepList() {
  const defaults = ["BAJ-447723"];
  const extra = String(process.env.SEED_MEYER_KEEP_DISCONTINUED_ZERO_SKUS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...defaults, ...extra]);
}

async function loadMeyerProductMap() {
  const products = await prisma.product.findMany({
    where: { status: 1, meyer_code: { not: "" } },
    select: { sku: true, meyer_code: true, brand_name: true },
  });
  const map = new Map();
  for (const product of products) {
    if (product.meyer_code) map.set(product.meyer_code, product.sku);
    if (isBajaBrand(product.brand_name)) {
      const bajaFallbackCode = toBajaVendorPart(product.sku) || toBajaVendorPart(product.meyer_code);
      if (bajaFallbackCode && !map.has(bajaFallbackCode)) map.set(bajaFallbackCode, product.sku);
    }
  }
  return map;
}

// Monta as linhas de staging (excluindo descontinuados+qty0, que vao para o
// sweep) e coleta os product_sku a remover. Mesma resolucao/filtro do legado
// (US pula linhas com custo nulo). Dedup por vendor_sku (ultimo vence).
function buildRows(fetched, productMap) {
  const rowsByKey = new Map();
  const discontinuedSkus = new Set();
  let rawCount = 0;

  for (const data of fetched) {
    if (!data || data.statusCode || !Array.isArray(data) || !data[0]) continue;
    const item = data[0];
    rawCount += 1;

    const productSku = resolveMeyerProductSku(productMap, item.ItemNumber);
    if (!productSku) continue;

    if (shouldRemoveMeyerVendor(item)) {
      discontinuedSkus.add(productSku);
      rowsByKey.delete(item.ItemNumber);
      continue;
    }

    const costUsd = safeFloat(item.CustomerPrice);
    if (costUsd === null) continue; // vendor_cost e' NOT NULL; legado tambem pula

    rowsByKey.set(item.ItemNumber, {
      product_sku: productSku,
      vendor_id: VENDOR_ID,
      vendor_sku: item.ItemNumber,
      vendor_cost: costUsd, // brand-new row precisa (NOT NULL) = valor USD, igual ao legado
      vendor_cost_usd: costUsd,
      vendor_inventory: safeFloat(item.QtyAvailable),
      partStatus_meyer: item.PartStatus || null,
      meyer_length: safeFloat(item.Length),
      meyer_width: safeFloat(item.Width),
      meyer_height: safeFloat(item.Height),
      meyer_weight: safeFloat(item.Weight),
    });
  }

  return { stagingRows: Array.from(rowsByKey.values()), discontinuedSkus, rawCount };
}

function hashRows(rows) {
  const canonical = rows
    .map((r) => STAGING_COLS.map((c) => (r[c] === null || r[c] === undefined ? "" : r[c])).join(""))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// UPDATE companheiro na Product (dims + partStatus), gated por IS DISTINCT FROM
// (o legado reescrevia a Product inteira a cada batch — churn evitavel).
async function updateProductDims(stagingTable) {
  const rows = await prisma.$queryRawUnsafe(`
    WITH upd AS (
      UPDATE "Product" p
         SET "partStatus_meyer" = s."partStatus_meyer",
             meyer_length = s.meyer_length, meyer_width = s.meyer_width,
             meyer_height = s.meyer_height, meyer_weight = s.meyer_weight
        FROM staging.${stagingTable} s
       WHERE p.sku = s.product_sku
         AND (p."partStatus_meyer" IS DISTINCT FROM s."partStatus_meyer"
           OR p.meyer_length IS DISTINCT FROM s.meyer_length
           OR p.meyer_width  IS DISTINCT FROM s.meyer_width
           OR p.meyer_height IS DISTINCT FROM s.meyer_height
           OR p.meyer_weight IS DISTINCT FROM s.meyer_weight)
      RETURNING 1
    ) SELECT count(*)::int AS n FROM upd
  `);
  return rows[0].n;
}

// Remove descontinuados (feed diz discontinued+qty0) por product_sku, de forma
// FK-safe (anula OrderProduct.vendor_product_id antes — o legado deletava direto
// e o ON DELETE CASCADE destruia line items historicos).
async function sweepDiscontinued(discontinuedSkus) {
  const keep = parseKeepList();
  const toDelete = Array.from(discontinuedSkus).filter((sku) => !keep.has(sku));
  let removed = 0;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const chunk = toDelete.slice(i, i + BATCH_SIZE);
    const inList = chunk.map((s) => `'${escapeSqlString(s)}'`).join(", ");
    removed += await deleteVendorProductsSafely(
      `t."vendor_id" = ${VENDOR_ID} AND t."product_sku" IN (${inList})`
    );
  }
  return removed;
}

async function seedMeyerUsStaged() {
  console.time("seed-meyer-us total");
  let run;
  let locked = false;
  try {
    locked = await acquireIngestLock(FEED, { leaseMinutes: LEASE_MINUTES });
    if (!locked) {
      console.log("⏭️  Outra rodada meyer-us em andamento (lock ativo). Abortado.");
      const r = await startRun(FEED, { sourceKind: "api", sourceRef: "ItemInformation" });
      await r.finish({ status: "skipped-locked", counts: { skipped: 1 } });
      return;
    }

    // FETCH (inalterado) — antes de tocar o banco; o lock ja foi pego para nao
    // duplicar pressao no rate limit do Meyer.
    const fetched = await meyerApiUs();

    // GUARD de falha silenciosa: chave expirada/rate limit faz todos os itens
    // voltarem como erro; sem isto a run reportaria "success" com ~0 escritas.
    const totalFetched = fetched.length;
    const failedFetch = fetched.filter((d) => d && d.statusCode).length;
    if (totalFetched > 0 && failedFetch / totalFetched > MAX_FAILED_RATIO) {
      throw new Error(
        `Fetch Meyer US degradado: ${failedFetch}/${totalFetched} itens falharam ` +
        `(> ${MAX_FAILED_RATIO}). Chave expirada ou rate limit? Abortado sem tocar o banco.`
      );
    }

    const productMap = await loadMeyerProductMap();
    const { stagingRows, discontinuedSkus, rawCount } = buildRows(fetched, productMap);

    const sourceHash = hashRows(stagingRows);
    run = await startRun(FEED, { sourceKind: "api", sourceRef: "ItemInformation", sourceHash });

    if (await isUnchanged(FEED, sourceHash)) {
      console.log("⏭️  Payload identico a ultima rodada bem-sucedida — nada a fazer.");
      await run.finish({ status: "skipped-unchanged", counts: { skipped: 1 } });
      return;
    }

    await ensureStagingTable(STAGING_TABLE, STAGING_DDL);
    for (let i = 0; i < stagingRows.length; i += BATCH_SIZE) {
      await insertBatch(STAGING_TABLE, STAGING_COLS, stagingRows.slice(i, i + BATCH_SIZE));
    }

    // staleStrategy 'none' (ver comentario do bloco). vendor_cost fica FORA de
    // compareCols: o US so escreve vendor_cost_usd em linhas existentes; so
    // preenche vendor_cost no INSERT de linha nova (satisfaz o NOT NULL).
    const counts = await diffApply({
      target: "VendorProduct",
      staging: `staging.${STAGING_TABLE}`,
      keyCols: ["vendor_id", "vendor_sku"],
      compareCols: ["vendor_cost_usd", "vendor_inventory", "partStatus_meyer"],
      insertCols: VP_INSERT_COLS,
      scopeWhereSql: `t."vendor_id" = ${VENDOR_ID}`,
      staleStrategy: "none",
    });

    const productUpdated = await updateProductDims(STAGING_TABLE);
    const removed = await sweepDiscontinued(discontinuedSkus);

    console.log(
      `✅ meyer-us: +${counts.inserted} inseridas, ~${counts.updated} atualizadas, ` +
      `Product ~${productUpdated} atualizadas, -${removed} descontinuadas removidas`
    );

    await run.finish({
      status: "success",
      counts: { inserted: counts.inserted, updated: counts.updated, deleted: removed },
      sourceRowCount: rawCount,
    });
  } catch (error) {
    console.error("❌ Erro no seed Meyer US (staged):", error);
    if (run) await run.finish({ status: "failed", error: error.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (locked) await releaseIngestLock(FEED).catch(() => {});
    await closePool().catch(() => {});
    await prisma.$disconnect();
    console.timeEnd("seed-meyer-us total");
  }
}

const seedMeyerUs = process.env.MEYER_US_PIPELINE === "legacy"
  ? seedMeyerUsVendorProducts
  : seedMeyerUsStaged;

seedMeyerUs();
module.exports = seedMeyerUs;
