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
// stage+diff pipeline (Jul 2026). Moves Meyer US to the lib/ingest pattern:
// writes only the delta (via IS DISTINCT FROM) instead of a blind upsert plus a
// rewrite of the whole Product row on every batch. staleStrategy 'none': absence
// from the feed NEVER deletes, because CA and US share vendor_id=2, and deletion
// here happens only for discontinued items (a positive predicate), never for
// absence. The fetch stays sequential (Meyer rate limit), so the runtime does
// not change; the gain is less write volume, provenance (IngestRun) and a
// silent-failure guard.
// Operational rollback:  MEYER_US_PIPELINE=legacy npm run seed-meyer-us
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
// All columns of the staging table (includes meyer_*, which belong to Product
// and are used only by the companion UPDATE: they do NOT exist on VendorProduct).
const STAGING_COLS = [
  "product_sku", "vendor_id", "vendor_sku", "vendor_cost", "vendor_cost_usd",
  "vendor_inventory", "partStatus_meyer",
  "meyer_length", "meyer_width", "meyer_height", "meyer_weight",
];
// Subset that DOES exist on VendorProduct, used by the diffApply INSERT. Without
// the meyer_* columns (otherwise the INSERT would reference columns that do not
// exist on VendorProduct).
const VP_INSERT_COLS = [
  "product_sku", "vendor_id", "vendor_sku", "vendor_cost", "vendor_cost_usd",
  "vendor_inventory", "partStatus_meyer",
];

// SKUs protected from deletion by discontinued status (business decision).
// Mirrors seed-meyer.js (CA): defaults + SEED_MEYER_KEEP_DISCONTINUED_ZERO_SKUS.
// On US the legacy code did not honor the keep list; honoring it only PREVENTS
// deletions (safer) and aligns CA with US.
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

// Builds the staging rows (excluding discontinued+qty0, which go to the sweep)
// and collects the product_sku values to remove. Same resolution and filter as
// the legacy version (US skips rows with a null cost). Dedup by vendor_sku (the
// last one wins).
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
    if (costUsd === null) continue; // vendor_cost is NOT NULL; the legacy version skips too

    rowsByKey.set(item.ItemNumber, {
      product_sku: productSku,
      vendor_id: VENDOR_ID,
      vendor_sku: item.ItemNumber,
      vendor_cost: costUsd, // a brand-new row requires it (NOT NULL) = USD value, same as legacy
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

// Companion UPDATE on Product (dims + partStatus), gated by IS DISTINCT FROM
// (the legacy version rewrote the whole Product row on every batch: avoidable
// churn).
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

// Removes discontinued items (the feed says discontinued+qty0) by product_sku in
// an FK-safe way (it nulls OrderProduct.vendor_product_id first: the legacy
// version deleted directly and ON DELETE CASCADE destroyed historical line
// items).
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
      console.log("⏭️  Another meyer-us run is in progress (lock held). Aborted.");
      const r = await startRun(FEED, { sourceKind: "api", sourceRef: "ItemInformation" });
      await r.finish({ status: "skipped-locked", counts: { skipped: 1 } });
      return;
    }

    // FETCH (unchanged), before touching the database; the lock was already
    // acquired so we do not double up pressure on the Meyer rate limit.
    const fetched = await meyerApiUs();

    // Silent-failure GUARD: an expired key or a rate limit makes every item come
    // back as an error; without this the run would report "success" with close
    // to 0 writes.
    const totalFetched = fetched.length;
    const failedFetch = fetched.filter((d) => d && d.statusCode).length;
    if (totalFetched > 0 && failedFetch / totalFetched > MAX_FAILED_RATIO) {
      throw new Error(
        `Meyer US fetch degraded: ${failedFetch}/${totalFetched} items failed ` +
        `(> ${MAX_FAILED_RATIO}). Expired key or rate limit? Aborted without touching the database.`
      );
    }

    const productMap = await loadMeyerProductMap();
    const { stagingRows, discontinuedSkus, rawCount } = buildRows(fetched, productMap);

    const sourceHash = hashRows(stagingRows);
    run = await startRun(FEED, { sourceKind: "api", sourceRef: "ItemInformation", sourceHash });

    if (await isUnchanged(FEED, sourceHash)) {
      console.log("⏭️  Payload identical to the last successful run: nothing to do.");
      await run.finish({ status: "skipped-unchanged", counts: { skipped: 1 } });
      return;
    }

    await ensureStagingTable(STAGING_TABLE, STAGING_DDL);
    for (let i = 0; i < stagingRows.length; i += BATCH_SIZE) {
      await insertBatch(STAGING_TABLE, STAGING_COLS, stagingRows.slice(i, i + BATCH_SIZE));
    }

    // staleStrategy 'none' (see the block comment above). vendor_cost stays OUT
    // of compareCols: US only writes vendor_cost_usd on existing rows, and only
    // fills vendor_cost on the INSERT of a new row (to satisfy the NOT NULL).
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
      `✅ meyer-us: +${counts.inserted} inserted, ~${counts.updated} updated, ` +
      `Product ~${productUpdated} updated, -${removed} discontinued removed`
    );

    await run.finish({
      status: "success",
      counts: { inserted: counts.inserted, updated: counts.updated, deleted: removed },
      sourceRowCount: rawCount,
    });
  } catch (error) {
    console.error("❌ Error in the Meyer US seed (staged):", error);
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
