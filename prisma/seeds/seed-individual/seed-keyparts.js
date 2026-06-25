const keypartsCost = require("../api-calls/keyparts");
const { USD_TO_CAD_RATE } = require("../../../utils/exchangeRate");

const prisma = require("../../../lib/prisma");

const VENDOR_ID = 11;
const COST_MULTIPLIER = USD_TO_CAD_RATE;
const CLEAR_EXISTING = false;
const UPSERT_BATCH_SIZE = 2000;
const MISSING_PRODUCT_SAMPLE_SIZE = 20;

const chunkArray = (items, chunkSize) => {
  if (!items.length) return [];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const upsertVendorProductsBatch = async (rows) => {
  if (!rows.length) return;

  const payload = JSON.stringify(rows);

  const updateSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        vendor_sku text,
        product_sku text,
        vendor_cost_usd double precision,
        vendor_cost double precision,
        vendor_inventory_string text
      )
    )
    UPDATE "VendorProduct" vp
    SET
      vendor_cost_usd = input.vendor_cost_usd,
      vendor_cost = input.vendor_cost,
      vendor_inventory_string = input.vendor_inventory_string
    FROM input
    WHERE vp.vendor_id = $1
      AND vp.vendor_sku = input.vendor_sku;
  `;

  const insertSql = `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($2::jsonb) AS x(
        vendor_sku text,
        product_sku text,
        vendor_cost_usd double precision,
        vendor_cost double precision,
        vendor_inventory_string text
      )
    )
    INSERT INTO "VendorProduct" (
      product_sku,
      vendor_id,
      vendor_sku,
      vendor_cost_usd,
      vendor_cost,
      vendor_inventory_string
    )
    SELECT
      input.product_sku,
      $1,
      input.vendor_sku,
      input.vendor_cost_usd,
      input.vendor_cost,
      input.vendor_inventory_string
    FROM input
    WHERE input.product_sku IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "VendorProduct" vp
        WHERE vp.vendor_id = $1
          AND vp.vendor_sku = input.vendor_sku
      );
  `;

  await prisma.$transaction([
    prisma.$executeRawUnsafe(updateSql, VENDOR_ID, payload),
    prisma.$executeRawUnsafe(insertSql, VENDOR_ID, payload),
  ]);
};

const seedKeyPartsProducts = async () => {
  const startTime = process.hrtime.bigint();
  console.log("🔁 Seeding KeyParts vendor products...");

  const products = await keypartsCost();
  let created = 0;
  let updated = 0;
  let missingProductCount = 0;
  const missingProductSamples = [];

  // ✅ Step 0: Clear old vendor products for KeyParts
  if (CLEAR_EXISTING) {
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } });
    console.log("🗑️ Deleted all existing KeyParts vendor products (vendor_id = 11)");
  }

  const itemsBySku = new Map();
  const duplicateItems = new Set();
  for (const data of products) {
    const item = data?.Item;
    if (!item) {
      continue;
    }
    if (itemsBySku.has(item)) {
      duplicateItems.add(item);
      continue;
    }
    itemsBySku.set(item, data);
  }

  const skuList = Array.from(itemsBySku.keys());

  const [existingVendorProducts, matchingProducts] = await prisma.$transaction([
    prisma.vendorProduct.findMany({
      where: {
        vendor_id: VENDOR_ID,
        vendor_sku: { in: skuList },
      },
      select: {
        id: true,
        vendor_sku: true,
      },
    }),
    prisma.product.findMany({
      where: {
        searchable_sku: { in: skuList },
        jj_prefix: "KEY",
      },
      select: {
        sku: true,
        searchable_sku: true,
      },
    }),
  ]);

  const existingBySku = new Map(
    existingVendorProducts.map((row) => [row.vendor_sku, row])
  );
  const productBySearchableSku = new Map(
    matchingProducts.map((row) => [row.searchable_sku, row])
  );

  const upsertRows = [];

  for (const [item, data] of itemsBySku) {
    const product = productBySearchableSku.get(item);
    if (!product) {
      missingProductCount++;
      if (missingProductSamples.length < MISSING_PRODUCT_SAMPLE_SIZE) {
        missingProductSamples.push(item);
      }
      continue;
    }

    const costUsd = Number(data.Cost);
    const payload = {
      vendor_cost_usd: costUsd,
      vendor_cost: costUsd * COST_MULTIPLIER,
      vendor_inventory_string: data.Inventory || null,
    };

    const existing = existingBySku.get(item);
    if (existing && !CLEAR_EXISTING) {
      updated++;
      upsertRows.push({
        vendor_sku: item,
        product_sku: null,
        ...payload,
      });
      continue;
    }

    created++;
    upsertRows.push({
      vendor_sku: item,
      product_sku: product.sku,
      ...payload,
    });
  }

  if (upsertRows.length > 0) {
    console.log(`⏳ Upserting ${upsertRows.length} KeyParts rows in batches of ${UPSERT_BATCH_SIZE}...`);
  }

  let processed = 0;
  for (const batch of chunkArray(upsertRows, UPSERT_BATCH_SIZE)) {
    await upsertVendorProductsBatch(batch);
    processed += batch.length;
    console.log(`✅ Upserted ${processed}/${upsertRows.length}`);
  }

  console.log(`✅ KeyParts seeding complete:
  ➕ Created: ${created}
  🔄 Updated: ${updated}`);

  if (duplicateItems.size > 0) {
    console.warn(
      `⚠️ Skipped ${duplicateItems.size} duplicate SKU(s) from source data.`
    );
  }

  if (missingProductCount > 0) {
    console.warn(
      `⚠️ Missing Product matches: ${missingProductCount}. Sample: ${missingProductSamples.join(", ")}`
    );
  }

  const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  console.log(`⏱️ Execution time: ${elapsedMs.toFixed(2)} ms`);

  await prisma.$disconnect();
};

if (require.main === module) {
  seedKeyPartsProducts();
}

module.exports = seedKeyPartsProducts;
