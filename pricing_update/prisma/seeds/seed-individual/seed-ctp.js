const ctpCost = require("../api-calls/ctp");

const prisma = require("../../../lib/prisma");
const { startRun } = require("../../../lib/ingest/ingestRun");

// Name this script records its run under (config/feeds.js -> ingestFeed). Without
// it the feeds panel fell back to a bookkeeping row with no counters, and its
// zeros read as "this script changed nothing" next to a run that had updated
// hundreds of products.
const FEED = "ctp";

const runWithConcurrency = async (items, limit, iterator) => {
  const executing = new Set();
  for (const item of items) {
    const promise = Promise.resolve().then(() => iterator(item));
    executing.add(promise);
    const cleanup = () => executing.delete(promise);
    promise.then(cleanup).catch(cleanup);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
};

const importCtpVendorProducts = async () => {
  const startTimeMs = Date.now();
  console.log("🔁 Seeding CTP vendor products...");

  const products = await ctpCost();
  let created = 0;
  let updated = 0;
  let missing = 0;

  const items = products.map((data) => data.Item).filter(Boolean);
  const chunkSize = 20000;
  const chunkedItems = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunkedItems.push(items.slice(i, i + chunkSize));
  }

  const existingVendorProducts = [];
  for (const chunk of chunkedItems) {
    const chunkResults = await prisma.vendorProduct.findMany({
      where: {
        vendor_id: 12,
        vendor_sku: { in: chunk },
      },
      select: {
        id: true,
        vendor_sku: true,
        vendor_cost: true,
        vendor_inventory: true,
      },
    });
    existingVendorProducts.push(...chunkResults);
  }
  const existingBySku = new Map(
    existingVendorProducts.map((vp) => [vp.vendor_sku, vp])
  );

  const matchedProducts = [];
  for (const chunk of chunkedItems) {
    const chunkResults = await prisma.product.findMany({
      where: { ctp_code: { in: chunk } },
      select: { sku: true, ctp_code: true },
    });
    matchedProducts.push(...chunkResults);
  }
  const productByCtpCode = new Map(
    matchedProducts.map((product) => [product.ctp_code, product])
  );

    //   // ✅ Step 0: Clear old vendor products for CTP
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 12 } });
    // console.log("🗑️ Deleted all existing CTP vendor products (vendor_id = 12)");

  const rowsToCreate = [];
  const rowsToUpdate = [];

  for (const data of products) {
    try {
      const existing = existingBySku.get(data.Item);
      const nextCost = data.Cost;
      const nextInventory = data.Inventory || null;

      if (existing) {
        if (
          existing.vendor_cost !== nextCost ||
          existing.vendor_inventory !== nextInventory
        ) {
          rowsToUpdate.push({
            id: existing.id,
            vendor_cost: nextCost,
            vendor_inventory: nextInventory,
          });
        }
        continue;
      }

      // Match using ctp_code instead of searchable_sku
      const product = productByCtpCode.get(data.Item);

      if (!product) {
        missing++;
        continue;
      }

      rowsToCreate.push({
        product_sku: product.sku,
        vendor_id: 12,
        vendor_sku: data.Item,
        vendor_cost: nextCost,
        vendor_inventory: nextInventory,
      });
    } catch (err) {
      console.error(`🔥 Error for ${data.Item}:`, err.message);
    }
  }

  const createChunkSize = 1000;
  for (let i = 0; i < rowsToCreate.length; i += createChunkSize) {
    const chunk = rowsToCreate.slice(i, i + createChunkSize);
    const result = await prisma.vendorProduct.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    created += result.count || 0;
  }

  const writeConcurrency = 15;
  await runWithConcurrency(rowsToUpdate, writeConcurrency, async (row) => {
    try {
      await prisma.vendorProduct.update({
        where: { id: row.id },
        data: {
          vendor_cost: row.vendor_cost,
          vendor_inventory: row.vendor_inventory,
        },
      });
      updated++;
    } catch (err) {
      console.error(`🔥 Error updating ${row.id}:`, err.message);
    }
  });

  console.log(`✅ CTP seeding complete:
  ➕ Created: ${created}
  🔄 Updated: ${updated}
  ⚠️ Missing products: ${missing}`);
  console.log(`⏱️ Execution time: ${Date.now() - startTimeMs}ms`);

  // Observed, not predicted: created is what createMany reported and updated is
  // incremented after each update returns.
  return { inserted: created, updated, skipped: missing, sourceRowCount: products.length };
};

const seedCTPProducts = async () => {
  const run = await startRun(FEED, { sourceKind: "csv", sourceRef: "CTPENT_Inventory.csv" });

  try {
    const { sourceRowCount, ...counts } = await importCtpVendorProducts();
    await run.finish({ status: "success", counts, sourceRowCount });
  } catch (error) {
    console.error("❌ CTP seeding failed:", error);
    await run.finish({ status: "failed", error: error.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

seedCTPProducts();
