const RoughCountryCost = require("../api-calls/roughCountry-excel.js");

const prisma = require("../../../lib/prisma");

const WRITE_BATCH_SIZE = 200;
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
    const createRows = [];
    const updateOperations = [];
    const mapUpdateOperations = [];

    const flushCreates = async () => {
      if (createRows.length === 0) {
        return;
      }
      for (const batch of chunk(createRows, WRITE_BATCH_SIZE)) {
        await prisma.vendorProduct.createMany({ data: batch });
      }
      createRows.length = 0;
    };

    const flushUpdates = async () => {
      if (updateOperations.length === 0) {
        return;
      }
      for (const ops of chunk(updateOperations, WRITE_BATCH_SIZE)) {
        await prisma.$transaction(ops);
      }
      updateOperations.length = 0;
    };

    const flushMapUpdates = async () => {
      if (mapUpdateOperations.length === 0) {
        return;
      }
      for (const ops of chunk(mapUpdateOperations, WRITE_BATCH_SIZE)) {
        await prisma.$transaction(ops);
      }
      mapUpdateOperations.length = 0;
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
        const vendorCost = rawCost * 1.5;
        const vendorInventoryString = data["AVAILABILITY"];
        const vendorInventory = data["TN_STOCK"];
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
          updateOperations.push(
            prisma.vendorProduct.update({
              where: { id: existingVendorProduct.id },
              data: {
                vendor_sku: vendorSku,
                vendor_cost: vendorCost,
                vendor_inventory_string: vendorInventoryString,
                vendor_inventory: vendorInventory,
                product: { connect: { sku: product.sku } },
              },
            })
          );
        } else {
          vendorProductCreatedCount += 1;
          createRows.push({
            vendor_sku: vendorSku,
            vendor_cost: vendorCost,
            vendor_inventory_string: vendorInventoryString,
            vendor_inventory: vendorInventory,
            vendor_id: ROUGH_COUNTRY_VENDOR_ID,
            product_sku: product.sku,
          });
        }

        if (hasMapValue) {
          mapUpdateOperations.push(
            prisma.product.update({
              where: { sku: product.sku },
              data: { MAP: rawMapValue },
            })
          );
        }

        processedCount += 1;
        if (processedCount % LOG_EVERY === 0) {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          logWithTimestamp(
            `roughCountry progress: ${processedCount}/${totalCount} in ${elapsedSeconds}s (created ${vendorProductCreatedCount}, updated ${vendorProductUpdatedCount}, missing ${missingProductCount}, dupes ${duplicateSkuCount})`
          );
        }

        if (createRows.length >= WRITE_BATCH_SIZE) {
          await flushCreates();
        }
        if (updateOperations.length >= WRITE_BATCH_SIZE) {
          await flushUpdates();
        }
        if (mapUpdateOperations.length >= WRITE_BATCH_SIZE) {
          await flushMapUpdates();
        }
      } catch (error) {
        // console.error(`Error processing vendor_sku:`, error);
      }
    }

    await flushCreates();
    await flushUpdates();
    await flushMapUpdates();

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
      `roughCountry seed data issues: invalid cost ${invalidCostCount}, invalid MAP ${invalidMapCount}`
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
