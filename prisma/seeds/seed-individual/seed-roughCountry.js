const RoughCountryCost = require("../api-calls/roughCountry-excel.js");

const prisma = require("../../../lib/prisma");
const { USD_TO_CAD_RATE } = require("../../../utils/exchangeRate");

const WRITE_BATCH_SIZE = 2000;
const LOG_EVERY = 500;
const ROUGH_COUNTRY_VENDOR_ID = 9;

const chunk = (list, size) => {
  const batches = [];
  for (let i = 0; i < list.length; i += size) {
    batches.push(list.slice(i, i + size));
  }
  return batches;
};

function logWithTimestamp(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Seed roughCountry products
const seedRoughCountry = async () => {
  logWithTimestamp("Seeding roughCountry vendor products...");
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let processedCount = 0;
    let emptySkuCount = 0;
    let duplicateSkuCount = 0;
    let missingProductCount = 0;
    let matchedExistingCount = 0;
    let matchedProductCount = 0;
    let invalidCostCount = 0;
    let invalidMapCount = 0;
    let invalidRetailPriceCount = 0;
    const startedAt = Date.now();

    // // ✅ Step 0: Clear old vendor products for Rough Country
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 9 } });
    // console.log("🗑️ Deleted all existing Rough Country vendor products (vendor_id = 9)");

    const vendorProductsData = await RoughCountryCost();

    const [existingVendorProducts, roughCountryProducts] = await Promise.all([
      prisma.vendorProduct.findMany({
        where: { vendor_id: ROUGH_COUNTRY_VENDOR_ID },
        select: { id: true, vendor_sku: true, product_sku: true },
      }),
      prisma.product.findMany({
        where: { brand_name: "Rough Country" },
        select: { sku: true, searchable_sku: true },
      }),
    ]);

    const vendorProductBySku = new Map(
      existingVendorProducts.map((vp) => [vp.vendor_sku, vp])
    );
    const productBySearchSku = new Map(
      roughCountryProducts
        .filter((p) => p.searchable_sku)
        .map((p) => [p.searchable_sku, p])
    );

    const seenSkus = new Set();
    const rowsToUpsert = [];
    const rowsToMapUpdate = [];

    const upsertVendorProductsBatch = async (batch) => {
      if (!batch || batch.length === 0) return;
      const payload = JSON.stringify(batch);

      const updateSql = `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            vendor_sku text,
            product_sku text,
            vendor_cost double precision,
            vendor_cost_usd double precision,
            vendor_retail_price_usd double precision,
            vendor_inventory double precision,
            vendor_inventory_string text
          )
        )
        UPDATE "VendorProduct" vp
        SET
          product_sku = input.product_sku,
          vendor_cost = input.vendor_cost,
          vendor_cost_usd = input.vendor_cost_usd,
          vendor_retail_price_usd = input.vendor_retail_price_usd,
          vendor_inventory = input.vendor_inventory,
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
            vendor_cost double precision,
            vendor_cost_usd double precision,
            vendor_retail_price_usd double precision,
            vendor_inventory double precision,
            vendor_inventory_string text
          )
        )
        INSERT INTO "VendorProduct" (
          product_sku,
          vendor_id,
          vendor_sku,
          vendor_cost,
          vendor_cost_usd,
          vendor_retail_price_usd,
          vendor_inventory,
          vendor_inventory_string
        )
        SELECT
          input.product_sku,
          $1,
          input.vendor_sku,
          input.vendor_cost,
          input.vendor_cost_usd,
          input.vendor_retail_price_usd,
          input.vendor_inventory,
          input.vendor_inventory_string
        FROM input
        WHERE NOT EXISTS (
          SELECT 1
          FROM "VendorProduct" vp
          WHERE vp.vendor_id = $1
            AND vp.vendor_sku = input.vendor_sku
        );
      `;

      await prisma.$transaction([
        prisma.$executeRawUnsafe(updateSql, ROUGH_COUNTRY_VENDOR_ID, payload),
        prisma.$executeRawUnsafe(insertSql, ROUGH_COUNTRY_VENDOR_ID, payload),
      ]);
    };

    const updateProductMapBatch = async (batch) => {
      if (!batch || batch.length === 0) return;
      const payload = JSON.stringify(batch);

      const mapUpdateSql = `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS x(
            product_sku text,
            map_value double precision
          )
        )
        UPDATE "Product" p
        SET "MAP" = input.map_value
        FROM input
        WHERE p.sku = input.product_sku
          AND input.map_value IS NOT NULL;
      `;

      await prisma.$executeRawUnsafe(mapUpdateSql, payload);
    };

    const totalCount = vendorProductsData.length;
    logWithTimestamp(`roughCountry rows loaded: ${totalCount}`);

    for (const data of vendorProductsData) {
      try {
        const vendorSku = String(data["SKU"] ?? "").trim();
        if (!vendorSku) {
          emptySkuCount += 1;
          continue;
        }
        if (seenSkus.has(vendorSku)) {
          duplicateSkuCount += 1;
          continue;
        }
        seenSkus.add(vendorSku);

        const rawCost = Number(data["COST"]);
        if (!Number.isFinite(rawCost)) {
          invalidCostCount += 1;
          continue;
        }
        const rawRetailPrice = Number.isFinite(Number(data["PRICE"]))
          ? Number(data["PRICE"])
          : Number(data["SALE_PRICE"]);
        const hasRetailPrice = Number.isFinite(rawRetailPrice) && rawRetailPrice > 0;
        if (!hasRetailPrice && ((data["PRICE"] != null && data["PRICE"] !== "") || (data["SALE_PRICE"] != null && data["SALE_PRICE"] !== ""))) {
          invalidRetailPriceCount += 1;
        }
        const vendorCost = rawCost * USD_TO_CAD_RATE;
        const vendorInventoryString = data["AVAILABILITY"];
        const rawInventory = Number(data["TN_STOCK"]);
        const vendorInventory = Number.isFinite(rawInventory)
          ? rawInventory
          : null;
        const rawMapValue = Number(data["MAP"]);
        const hasMapValue = Number.isFinite(rawMapValue);
        if (!hasMapValue && data["MAP"] != null && data["MAP"] !== "") {
          invalidMapCount += 1;
        }

        const existingVendorProduct = vendorProductBySku.get(vendorSku);
        const product = existingVendorProduct
          ? { sku: existingVendorProduct.product_sku }
          : productBySearchSku.get(vendorSku);

        if (!product) {
          missingProductCount += 1;
          continue;
        }
        matchedProductCount += 1;

        if (existingVendorProduct) {
          matchedExistingCount += 1;
          vendorProductUpdatedCount += 1;
        } else {
          vendorProductCreatedCount += 1;
        }

        rowsToUpsert.push({
          vendor_sku: vendorSku,
          vendor_cost: vendorCost,
          vendor_cost_usd: rawCost,
          vendor_retail_price_usd: hasRetailPrice ? rawRetailPrice : null,
          vendor_inventory_string: vendorInventoryString,
          vendor_inventory: vendorInventory,
          product_sku: product.sku,
        });

        if (hasMapValue) {
          rowsToMapUpdate.push({
            product_sku: product.sku,
            map_value: rawMapValue,
          });
        }

        processedCount += 1;
        if (processedCount % LOG_EVERY === 0) {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          logWithTimestamp(
            `roughCountry progress: ${processedCount}/${totalCount} in ${elapsedSeconds}s (created ${vendorProductCreatedCount}, updated ${vendorProductUpdatedCount}, missing ${missingProductCount}, dupes ${duplicateSkuCount})`
          );
        }

      } catch (error) {
        // console.error(`Error processing vendor_sku:`, error);
      }
    }

    for (const batch of chunk(rowsToUpsert, WRITE_BATCH_SIZE)) {
      await upsertVendorProductsBatch(batch);
    }

    for (const batch of chunk(rowsToMapUpdate, WRITE_BATCH_SIZE)) {
      await updateProductMapBatch(batch);
    }

    const totalElapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const rowsPerSecond = totalElapsedSeconds
      ? Math.round(processedCount / totalElapsedSeconds)
      : processedCount;
    logWithTimestamp(
      `roughCountry seed runtime: ${totalElapsedSeconds}s (${rowsPerSecond} rows/s over ${processedCount} rows)`
    );
    logWithTimestamp(
      `roughCountry seed summary: matched products ${matchedProductCount}, existing vendor products ${matchedExistingCount}, missing products ${missingProductCount}, empty SKU ${emptySkuCount}, duplicate SKU ${duplicateSkuCount}`
    );
    logWithTimestamp(
      `roughCountry seed data issues: invalid cost ${invalidCostCount}, invalid retail price ${invalidRetailPriceCount}, invalid MAP ${invalidMapCount}`
    );
    logWithTimestamp(
      `roughCountry vendor products seeded successfully! Created: ${vendorProductCreatedCount}, Updated: ${vendorProductUpdatedCount}`
    );
  } catch (error) {
    console.error("Error seeding vendor products from roughCountry:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedRoughCountry();
module.exports = seedRoughCountry;
