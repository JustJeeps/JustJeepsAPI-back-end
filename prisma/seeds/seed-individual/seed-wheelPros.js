/* prisma/seeds/seed-individual/seed-wheelPros.js */

const prisma = require("../../../lib/prisma");

const {
  getAuthToken,
  getWheelProsSkus,
  makeApiRequestsInChunks,
} = require("../api-calls/wheelPros-api.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryablePrismaError = (error) => {
  if (!error) return false;
  // Common transient / connection-ish Prisma errors
  if (error.code === "P1017" || error.code === "P2028") return true;
  return (
    typeof error.message === "string" &&
    (error.message.includes("Server has closed the connection") ||
      error.message.includes("Connection terminated") ||
      error.message.includes("Transaction already closed"))
  );
};

const runWithRetry = async (
  operation,
  context,
  { maxRetries = 5, baseDelayMs = 400 } = {}
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const retryable = isRetryablePrismaError(err);
      if (!retryable || attempt === maxRetries) {
        err._context = context;
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `⚠️ Retryable Prisma error in ${context} (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`
      );
      try {
        await prisma.$disconnect();
        await prisma.$connect();
      } catch (reconnectErr) {
        console.warn("⚠️ Reconnect attempt failed. Will retry anyway.");
      }
      await sleep(delayMs);
    }
  }
};

// Keep EXACT same normalization rules you had
const normalizeWheelProsSkuForLookup = (sku) => {
  let formattedSku = sku;

  // Remove leading zeros for TeraFlex
  if (sku.startsWith("0000000000")) {
    formattedSku = sku.replace(/^0+/, "");
  }

  // Remove SB prefix for Smittybilt
  if (sku.startsWith("SB")) {
    formattedSku = sku.substring(2);
  }

  // Remove PXA prefix for PRO COMP Alloy Wheels
  if (sku.startsWith("PXA")) {
    formattedSku = sku.substring(3);
  }

  // Remove EXP prefix for PRO COMP Suspension
  if (sku.startsWith("EXP")) {
    formattedSku = sku.substring(3);
  }

  // Remove N prefix and dash for Nitto Tire (N123-456 -> 123456)
  if (sku.startsWith("N") && /^\d{3}-\d{3}$/.test(sku.substring(1))) {
    formattedSku = sku.substring(1).replace("-", "");
  }

  return formattedSku;
};

const safeFloat = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Deduplicate vendor rows by vendor_sku (WheelPros duplicates exist)
// Rule: Prefer row with valid cost; if both valid, prefer higher cost (rare) then higher MAP (rare)
const dedupeByVendorSku = (rows) => {
  const map = new Map();
  let duplicates = 0;

  for (const r of rows) {
    const sku = r.vendor_sku;
    if (!sku) continue;

    if (!map.has(sku)) {
      map.set(sku, r);
      continue;
    }

    duplicates++;

    const cur = map.get(sku);

    const curCost = cur.vendor_cost ?? null;
    const newCost = r.vendor_cost ?? null;
    const curMap = cur.map_price ?? null;
    const newMap = r.map_price ?? null;

    // Prefer valid cost
    if (curCost === null && newCost !== null) {
      map.set(sku, r);
      continue;
    }
    if (curCost !== null && newCost === null) {
      continue;
    }

    // If both have cost, prefer higher cost (or keep existing)
    if (curCost !== null && newCost !== null) {
      if (newCost > curCost) {
        map.set(sku, r);
        continue;
      }
      if (newCost < curCost) continue;
    }

    // Tie-breaker: prefer higher MAP if present
    if (curMap === null && newMap !== null) {
      map.set(sku, r);
      continue;
    }
    if (curMap !== null && newMap === null) continue;

    if (curMap !== null && newMap !== null && newMap > curMap) {
      map.set(sku, r);
      continue;
    }
  }

  return { uniqueRows: Array.from(map.values()), duplicates };
};

// Update Product.MAP in batches using VALUES table
const updateMapBatch = async (pairs, batchLabel) => {
  // pairs: [{ product_sku, map_price }]
  if (!pairs.length) return;

  const valuesSql = pairs
    .map(
      (_, i) =>
        `($${i * 2 + 1}::text, $${i * 2 + 2}::double precision)`
    )
    .join(",");

  const params = [];
  for (const p of pairs) {
    params.push(p.product_sku);
    params.push(p.map_price);
  }

  const sql = `
    UPDATE "Product" p
    SET "MAP" = v.map_price
    FROM (VALUES ${valuesSql}) AS v(product_sku, map_price)
    WHERE p."sku" = v.product_sku
  `;

  await runWithRetry(
    () => prisma.$executeRawUnsafe(sql, ...params),
    `MAP update ${batchLabel}`
  );
};

  // ✅ Step 0: Clear old vendor products for WheelPros (moved into async function)
const seedWheelProsProducts = async () => {
  console.log("🚀 Seeding WheelPros vendor products...");

  const t0 = Date.now();
  const batchSize = Number(process.env.SEED_WP_BATCH_SIZE || 5000);
  const apiChunkSize = Number(process.env.SEED_WP_API_CHUNK_SIZE || 50);

  try {
    // 1) Clear old WheelPros vendor products
    console.time("delete old vendor_id=5");
    await runWithRetry(
      () => prisma.vendorProduct.deleteMany({ where: { vendor_id: 5 } }),
      "deleteMany vendor_id=5"
    );
    console.timeEnd("delete old vendor_id=5");

    // 2) Fetch token + SKUs + API payload
    console.time("fetch wheelpros api");
    const token = await getAuthToken();
    const skus = await getWheelProsSkus();
    const apiRows = await makeApiRequestsInChunks(token, skus, apiChunkSize);
    console.timeEnd("fetch wheelpros api");

    console.log(`✅ API rows received: ${apiRows.length}`);

    // 3) Build “raw rows” from API response
    const rawRows = apiRows.map((d) => {
      const vendorSku = d?.sku ? String(d.sku) : null;

      const vendorCost = safeFloat(d?.prices?.nip?.[0]?.currencyAmount);
      const mapPrice = safeFloat(d?.prices?.map?.[0]?.currencyAmount);

      const formattedSku = vendorSku ? normalizeWheelProsSkuForLookup(vendorSku) : null;

      return {
        vendor_sku: vendorSku,
        formatted_sku: formattedSku,
        vendor_cost: vendorCost,
        map_price: mapPrice,
      };
    });

    const usableRaw = rawRows.filter((r) => r.vendor_sku && r.formatted_sku);
    console.log(`✅ Rows usable (have vendor_sku + formatted_sku): ${usableRaw.length}`);

    // 4) Deduplicate by vendor_sku (WheelPros duplicates exist)
    const { uniqueRows, duplicates } = dedupeByVendorSku(usableRaw);
    console.log(`ℹ️ Deduped vendor_sku duplicates: ${duplicates}`);
    console.log(`✅ Unique vendor_sku rows after dedupe: ${uniqueRows.length}`);

    // 5) Load Products by searchable_sku in chunks (avoid 100k+ IN list at once)
    console.time("fetch products mapping");
    const formattedSkus = uniqueRows.map((r) => r.formatted_sku);

    const productBySearchable = new Map();
    const chunkSize = 20000;

    // WheelPros allowed brands (must match getWheelProsSkus)
    const wheelProsBrands = [
      "American Racing", "Black Rhino", "Fuel Off-Road", "KMC Wheels",
      "ReadyLIFT", "Morimoto", "TeraFlex", "Gorilla Automotive",
      "G2 Axle & Gear", "Poison Spyder Customs", "PRO COMP Alloy Wheels",
      "PRO COMP Steel Wheels", "PRO COMP Suspension", "Pro Comp Tires",
      "Rubicon Express", "Smittybilt", "Nitto Tire", "Bilstein", "Fox Racing"
    ];

    for (let i = 0; i < formattedSkus.length; i += chunkSize) {
      const chunk = formattedSkus.slice(i, i + chunkSize);

      const products = await runWithRetry(
        () =>
          prisma.product.findMany({
            where: { searchable_sku: { in: chunk } },
            select: { sku: true, searchable_sku: true, brand_name: true },
          }),
        `findMany Product searchable_sku chunk ${i / chunkSize + 1}`
      );

      for (const p of products) {
        if (p.searchable_sku && wheelProsBrands.includes(p.brand_name)) {
          productBySearchable.set(p.searchable_sku, p.sku);
        }
      }
    }
    console.timeEnd("fetch products mapping");

    // 6) Build VendorProduct rows
    let matched = 0;
    let missing = 0;
    let skippedNoCost = 0;

    const vendorRowsToInsert = [];
    const mapPairs = []; // for Product MAP updates

    for (const r of uniqueRows) {
      const productSku = productBySearchable.get(r.formatted_sku);
      if (!productSku) {
        missing++;
        continue;
      }
      matched++;

      // create vendorProduct only if cost exists
      if (r.vendor_cost === null) {
        skippedNoCost++;
        // still update MAP if available
        if (r.map_price !== null) {
          mapPairs.push({ product_sku: productSku, map_price: r.map_price });
        }
        continue;
      }

      vendorRowsToInsert.push({
        product_sku: productSku,
        vendor_id: 5,
        vendor_sku: r.vendor_sku,
        vendor_cost: r.vendor_cost,
      });

      if (r.map_price !== null) {
        mapPairs.push({ product_sku: productSku, map_price: r.map_price });
      }
    }

    console.log(`✅ Matched products: ${matched}`);
    console.log(`⚠️ Missing products: ${missing}`);
    console.log(`⚠️ Skipped (no cost): ${skippedNoCost}`);

    // 7) Insert vendor products in batches + progress/ETA
    console.time("insert vendorProducts");
    const total = vendorRowsToInsert.length;
    const totalBatches = Math.max(1, Math.ceil(total / batchSize));
    const start = Date.now();

    for (let b = 0; b < totalBatches; b++) {
      const batch = vendorRowsToInsert.slice(b * batchSize, (b + 1) * batchSize);

      await runWithRetry(
        () =>
          prisma.vendorProduct.createMany({
            data: batch,
            skipDuplicates: false, // schema doesn't enforce vendor_sku uniqueness; we dedupe ourselves
          }),
        `createMany vendorProducts batch ${b + 1}/${totalBatches}`
      );

      // progress log every 5 batches or last batch
      const done = Math.min((b + 1) * batchSize, total);
      const elapsedSec = Math.max((Date.now() - start) / 1000, 0.001);
      const rowsPerSec = done / elapsedSec;
      const remaining = total - done;
      const etaSec = Math.round(remaining / rowsPerSec);

      if ((b + 1) % 5 === 0 || b + 1 === totalBatches) {
        console.log(
          `Batch ${b + 1}/${totalBatches} | ${done}/${total} rows | ${rowsPerSec.toFixed(
            1
          )} rows/s | ETA ~${etaSec}s`
        );
      }
    }

    console.timeEnd("insert vendorProducts");

    // 8) Update Product MAP in batches (fast)
    console.time("update MAP");
    // Deduplicate MAP updates by product_sku (take latest/highest; simple “keep last”)
    const mapByProductSku = new Map();
    for (const p of mapPairs) {
      mapByProductSku.set(p.product_sku, p.map_price);
    }
    const uniqueMapPairs = Array.from(mapByProductSku.entries()).map(
      ([product_sku, map_price]) => ({ product_sku, map_price })
    );

    const mapBatchSize = 3000; // keep SQL statement size reasonable
    const mapTotalBatches = Math.max(1, Math.ceil(uniqueMapPairs.length / mapBatchSize));

    for (let i = 0; i < mapTotalBatches; i++) {
      const batch = uniqueMapPairs.slice(i * mapBatchSize, (i + 1) * mapBatchSize);
      await updateMapBatch(batch, `batch ${i + 1}/${mapTotalBatches}`);
    }
    console.timeEnd("update MAP");

    // 9) Final validation count
    const count = await prisma.vendorProduct.count({ where: { vendor_id: 5 } });
    console.log("✅ VendorProduct count for WheelPros (vendor_id=5):", count);

    console.log("✅ WheelPros seed completed successfully.");
  } catch (err) {
    console.error("❌ seed-wheelPros failed:", err?._context || err.message);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    const totalSec = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`seed-wheelPros total: ${totalSec}s`);
  }
};


// Run the seeder if called directly
if (require.main === module) {
  seedWheelProsProducts();
}

module.exports = seedWheelProsProducts;

//     // ✅ Step 0: Clear old vendor products for WheelPros
//     await prisma.vendorProduct.deleteMany({ where: { vendor_id: 5 } });
//     console.log("🗑️ Deleted all existing WheelPros vendor products (vendor_id = 5)");


// const { 
//   getAuthToken,
//   getWheelProsSkus,
//   makeApiRequestsInChunks,
// } = require("../api-calls/wheelPros-api.js");

// const prisma = require("../../../lib/prisma");

// const seedWheelProsProducts = async () => {
//   console.log("🚀 Seeding WheelPros vendor products...");
//   try {
//     let vendorProductCreatedCount = 0;
//     let vendorProductUpdatedCount = 0;

//     // ✅ Step 0: Clear old vendor products for WheelPros
//     await prisma.vendorProduct.deleteMany({ where: { vendor_id: 5 } });
//     console.log("🗑️ Deleted all existing WheelPros vendor products (vendor_id = 5)");

//     // ✅ Step 1: Get token and SKUs
//     const token = await getAuthToken();
//     const skus = await getWheelProsSkus();

//     // ✅ Step 2: Fetch vendor product data
//     const vendorProductsData = await makeApiRequestsInChunks(token, skus, 50);
//     console.log(`🔍 API returned ${vendorProductsData.length} vendor products`);


//     // ✅ Process each vendor product
//     // ✅ Process each vendor product
//     for (const data of vendorProductsData) {
//       const vendorCost = parseFloat(data.prices?.nip?.[0]?.currencyAmount);
//       const mapPrice   = parseFloat(data.prices?.map?.[0]?.currencyAmount);

//       console.log(
//         `🔍 Processing SKU: ${data.sku} | Cost: ${isNaN(vendorCost) ? "❌ NaN" : vendorCost} | MAP: ${isNaN(mapPrice) ? "❌ NaN" : mapPrice}`
//       );

//       try {
//         // ✅ Check if vendor product already exists
//         const existingVendorProduct = await prisma.vendorProduct.findFirst({
//           where: { vendor_sku: data.sku, vendor_id: 5 },
//         });

//         if (existingVendorProduct) {
//           vendorProductUpdatedCount++;

//           if (!isNaN(vendorCost)) {
//             await prisma.vendorProduct.update({
//               where: { id: existingVendorProduct.id },
//               data: { vendor_cost: vendorCost },
//             });
//           } else {
//             console.warn(`⚠️ Skipping vendor cost update for SKU: ${data.sku} (invalid cost)`);
//           }

//           if (!isNaN(mapPrice)) {
//             await prisma.product.update({
//               where: { sku: existingVendorProduct.product_sku },
//               data: { MAP: mapPrice },
//             });
//           } else {
//             console.warn(`⚠️ Skipping MAP update for SKU: ${data.sku} (invalid MAP)`);
//           }

//           continue; // move to next SKU
//         }

//         // ✅ Normalize SKU for lookup
//         let formattedSku = data.sku;
//         if (data.sku.startsWith("0000000000")) formattedSku = data.sku.replace(/^0+/, "");
//         if (data.sku.startsWith("SB")) formattedSku = data.sku.substring(2);
//         if (data.sku.startsWith("PXA")) formattedSku = data.sku.substring(3);
//         if (data.sku.startsWith("EXP")) formattedSku = data.sku.substring(3);
//         if (data.sku.startsWith("N") && /^\d{3}-\d{3}$/.test(data.sku.substring(1)))
//           formattedSku = data.sku.substring(1).replace("-", "");

//         const product = await prisma.product.findFirst({
//           where: { searchable_sku: formattedSku },
//         });

//         if (!product) {
//           console.error(`❌ Product not found for WheelPros sku: ${data.sku}`);
//           continue;
//         }

//         // ✅ Create vendorProduct only if cost is valid
//         if (!isNaN(vendorCost)) {
//           await prisma.vendorProduct.create({
//             data: {
//               product_sku: product.sku,
//               vendor_id: 5,
//               vendor_sku: data.sku,
//               vendor_cost: vendorCost,
//             },
//           });
//           vendorProductCreatedCount++;
//         } else {
//           console.warn(`⚠️ Skipping vendor product creation for SKU: ${data.sku} (invalid cost)`);
//         }

//         // ✅ Update MAP only if valid
//         if (!isNaN(mapPrice)) {
//           await prisma.product.update({
//             where: { sku: product.sku },
//             data: { MAP: mapPrice },
//           });
//         } else {
//           console.warn(`⚠️ Skipping MAP update for SKU: ${data.sku} (invalid MAP)`);
//         }

//       } catch (err) {
//         console.error(`❌ Failed to process SKU: ${data.sku}`);
//         console.error(`   ↳ Reason: ${err.message}`);
//       }
//     }


//     console.log(`✅ WheelPros vendor products seeded successfully!
//       ➕ Created: ${vendorProductCreatedCount}
//       🔄 Updated: ${vendorProductUpdatedCount}`);
//   } catch (err) {
//     console.error("❌ Error seeding vendor products from WheelPros:", err.message);
//   }
// };

// seedWheelProsProducts();
// module.exports = seedWheelProsProducts;



