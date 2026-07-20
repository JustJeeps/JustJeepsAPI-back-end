// prisma/seeds/seed-individual/seed-wheelPros-inventory.js

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const prisma = require("../../../lib/prisma");

const VENDOR_ID = 5; // WheelPros

// US and CAD stock columns (as in your current script)
const usStockColumns = ["1011", "1015", "1019", "1022", "1028", "1031", "1036", "1072", "1085", "1086", "1088"];
const cadStockColumns = ["4033", "4035"];

// ---------------------------
// Helpers
// ---------------------------
function safeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function getStockString(row) {
  const usTotal = usStockColumns.reduce((sum, col) => sum + safeInt(row[col]), 0);
  const cadTotal = cadStockColumns.reduce((sum, col) => sum + safeInt(row[col]), 0);
  return `CAD stock: ${cadTotal} / US stock: ${usTotal}`;
}

function getVendorInventory(row) {
  // If inventory is missing, return 0
  const inv = safeInt(row.TotalQOH);
  return Number.isFinite(inv) ? inv : 0;
}

// Read + parse CSV (sync, like your current script)
function readCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing WheelPros CSV file: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  const ageHours = (Date.now() - stats.mtimeMs) / 36e5;
  const content = fs.readFileSync(filePath, "utf-8");
  const records = parse(content, { columns: true, skip_empty_lines: true });
  console.log(
    `📄 Loaded ${records.length.toLocaleString()} rows from ${path.basename(filePath)} (modified ${stats.mtime.toISOString()}, ~${ageHours.toFixed(1)}h old)`
  );
  if (ageHours > 24) {
    console.warn(`⚠️  ${path.basename(filePath)} is older than 24h — may not be today's feed`);
  }
  return records;
}

function formatSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "~0s";
  if (sec < 60) return `~${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `~${m}m ${s}s`;
}

// Batched UPDATE using VALUES table.
// Updates all rows where vendor_id + vendor_sku matches.
async function updateInventoryBatch(rows) {
  if (!rows.length) return { updatedRows: 0 };

  // IMPORTANT:
  // - We pass vendor_sku (PartNumber), vendor_inventory, vendor_inventory_string
  // - We update by (vendor_id, vendor_sku), which may match multiple VendorProduct rows (allowed).
  //
  // This avoids the "ON CONFLICT DO UPDATE affects row twice" issue entirely,
  // because we're doing UPDATE ... FROM, not INSERT ... ON CONFLICT.

  // Build VALUES placeholders: ($1,$2,$3), ($4,$5,$6), ...
  const valuesSql = rows
    .map((_, i) => {
      const base = i * 3;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    })
    .join(", ");

  const params = [];
  for (const r of rows) {
    params.push(r.vendor_sku);
    params.push(r.vendor_inventory); // int
    params.push(r.vendor_inventory_string); // string
  }

  // Use $executeRawUnsafe because Prisma doesn't support dynamic VALUES count safely with $executeRaw template.
  const sql = `
    UPDATE "VendorProduct" vp
    SET
      "vendor_inventory" = v.vendor_inventory,
      "vendor_inventory_string" = v.vendor_inventory_string
    FROM (VALUES ${valuesSql}) AS v(vendor_sku, vendor_inventory, vendor_inventory_string)
    WHERE vp."vendor_id" = ${VENDOR_ID}
      AND vp."vendor_sku" = v.vendor_sku
  `;

  const updatedRows = await prisma.$executeRawUnsafe(sql, ...params);
  return { updatedRows };
}

async function seedWheelProsInventory() {
  const start = Date.now();
  console.log("🚀 Updating WheelPros inventory (vendor_id=5) from local CSVs...");

  const dataDir = path.resolve(__dirname, "../api-calls");
  const files = [
    path.resolve(dataDir, "accessoriesInvPriceData.csv"),
    path.resolve(dataDir, "tireInvPriceData.csv"),
    path.resolve(dataDir, "wheelInvPriceData.csv"),
  ];

  // 1) Load CSVs + build deduped map by PartNumber (vendor_sku)
  console.time("parse CSVs");
  const summary = [];
  const map = new Map(); // vendor_sku -> { vendor_sku, vendor_inventory, vendor_inventory_string }
  let totalRows = 0;
  let emptySku = 0;
  let duplicates = 0;

  for (const f of files) {
    const recs = readCsv(f);
    totalRows += recs.length;

    let haveSku = 0;
    let fileDuplicates = 0;

    for (const row of recs) {
      const vendor_sku = (row.PartNumber || "").trim();
      if (!vendor_sku) {
        emptySku++;
        continue;
      }
      haveSku++;

      // Always set inventory to 0 if missing or invalid
      let vendor_inventory = getVendorInventory(row);
      if (!Number.isFinite(vendor_inventory) || vendor_inventory === null || vendor_inventory === undefined) {
        vendor_inventory = 0;
      }
      const vendor_inventory_string = getStockString(row);

      // If duplicates happen across files, keep the row with HIGHER TotalQOH
      if (map.has(vendor_sku)) {
        duplicates++;
        fileDuplicates++;
        const prev = map.get(vendor_sku);
        if (vendor_inventory > prev.vendor_inventory) {
          map.set(vendor_sku, { vendor_sku, vendor_inventory, vendor_inventory_string });
        }
      } else {
        map.set(vendor_sku, { vendor_sku, vendor_inventory, vendor_inventory_string });
      }
    }

    summary.push({
      file: path.basename(f),
      rows: recs.length,
      haveSku,
      fileDuplicates,
    });
  }

  console.log("🧪 PartNumber extraction summary per file:", summary);
  console.log(`📦 Total rows parsed: ${totalRows.toLocaleString()}`);
  console.log(`✅ Unique vendor_sku after merge: ${map.size.toLocaleString()}`);
  console.log(`ℹ️ Empty PartNumber rows: ${emptySku.toLocaleString()}`);
  console.log(`ℹ️ Deduped duplicates: ${duplicates.toLocaleString()}`);
  console.timeEnd("parse CSVs");

  // 2) Batch UPDATE
  const uniqueRows = Array.from(map.values());

  // Tune this if needed.
  // 2,000–10,000 is usually fine. Start with 5,000 like your Quad scripts.
  const BATCH_SIZE = Number(process.env.SEED_WP_INV_BATCH_SIZE || 5000);

  console.time("update vendorProducts");
  const totalBatches = Math.ceil(uniqueRows.length / BATCH_SIZE);

  let processed = 0;
  let totalUpdated = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batchStart = Date.now();
    const batch = uniqueRows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

    const { updatedRows } = await updateInventoryBatch(batch);

    processed += batch.length;
    totalUpdated += Number(updatedRows) || 0;

    const elapsedSec = (Date.now() - start) / 1000;
    const rate = processed / Math.max(elapsedSec, 0.001); // rows/s
    const remaining = uniqueRows.length - processed;
    const etaSec = remaining / Math.max(rate, 0.001);

    // Log every batch (or adjust to every N batches)
    const batchElapsed = Date.now() - batchStart;
    console.log(
      `Batch ${b + 1}/${totalBatches} | ${processed}/${uniqueRows.length} rows | ` +
        `${rate.toFixed(1)} rows/s | ETA ${formatSeconds(etaSec)} | batch ${batchElapsed}ms | updatedRows=${updatedRows}`
    );
  }

  console.timeEnd("update vendorProducts");

  // 3) Quick verification counts
  const vpCount = await prisma.vendorProduct.count({ where: { vendor_id: VENDOR_ID } });
  console.log(`✅ VendorProduct total for WheelPros (vendor_id=${VENDOR_ID}): ${vpCount.toLocaleString()}`);
  console.log(`✅ Inventory update batches applied. Total rows matched & updated (sum of batch updatedRows): ${totalUpdated.toLocaleString()}`);

  const totalSec = (Date.now() - start) / 1000;
  console.log(`seed-wheelPros-inventory total: ${totalSec.toFixed(2)}s`);
}

seedWheelProsInventory()
  .catch((err) => {
    console.error("❌ seed-wheelPros-inventory failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


// const fs = require("fs");
// const path = require("path");
// const { parse } = require("csv-parse/sync");

// const prisma = require("../../../lib/prisma");
// const VENDOR_ID = 5; // WheelPros

// // US and CAD stock columns
// const usStockColumns = ["1011", "1015", "1019", "1022", "1028", "1031", "1036", "1072", "1085", "1086", "1088"];
// const cadStockColumns = ["4033", "4035"];

// // Normalize SKU (PartNumber)
// function normalizeSku(sku) {
//   if (!sku) return "";
//   let formattedSku = sku;

//   if (formattedSku.startsWith("0000000000")) {
//     formattedSku = formattedSku.replace(/^0+/, "");
//   } else if (formattedSku.startsWith("SB")) {
//     formattedSku = formattedSku.substring(2);
//   } else if (formattedSku.startsWith("PXA")) {
//     formattedSku = formattedSku.substring(3);
//   } else if (formattedSku.startsWith("EXP")) {
//     formattedSku = formattedSku.substring(3);
//   } else if (formattedSku.startsWith("N") && formattedSku.includes("-")) {
//     // Handle Nitto format like N205-770 -> 205770
//     formattedSku = formattedSku.substring(1).replace("-", "");
//   }

//   return formattedSku;
// }

// // Calculate stock string
// function getStockString(row) {
//   const usTotal = usStockColumns.reduce((sum, col) => sum + (parseInt(row[col]) || 0), 0);
//   const cadTotal = cadStockColumns.reduce((sum, col) => sum + (parseInt(row[col]) || 0), 0);
//   return `CAD stock: ${cadTotal} / US stock: ${usTotal}`;
// }

// // Get vendor inventory from TotalQOH
// function getVendorInventory(row) {
//   return parseInt(row.TotalQOH) || 0;
// }

// // Process each file into enriched inventory rows (in-memory)
// function processFile(filePath) {
//   if (!fs.existsSync(filePath)) {
//     throw new Error(`Missing WheelPros CSV file: ${filePath}`);
//   }

//   const content = fs.readFileSync(filePath, "utf-8");
//   const records = parse(content, {
//     columns: true,
//     skip_empty_lines: true,
//   });

//   console.log(`📄 Loaded ${records.length} rows from ${filePath}`);

//   return records.map((row) => ({
//     ...row,
//     formattedSku: normalizeSku(row.PartNumber),
//     vendor_inventory_string: getStockString(row),
//     vendor_inventory: getVendorInventory(row),
//   }));
// }

// // Load raw WheelPros CSVs and build enriched inventory in memory
// const dataDir = path.resolve(__dirname, "../api-calls");
// const enrichedInventory = [
//   ...processFile(path.resolve(dataDir, "accessoriesInvPriceData.csv")),
//   ...processFile(path.resolve(dataDir, "tireInvPriceData.csv")),
//   ...processFile(path.resolve(dataDir, "wheelInvPriceData.csv")),
// ];

// // Helper: Get vendor product by vendor_sku (PartNumber)
// const updateInventory = async () => {
//   let updatedCount = 0;
//   let missingCount = 0;
//   const BATCH_SIZE = 100; // Process in batches to avoid connection pool exhaustion

//   console.log("🔄 Updating WheelPros vendor inventory...");

//   try {
//     // Process in batches
//     for (let i = 0; i < enrichedInventory.length; i += BATCH_SIZE) {
//       const batch = enrichedInventory.slice(i, i + BATCH_SIZE);
      
//       for (const row of batch) {
//         const vendorSku = row.PartNumber;
//         const vendor_inventory_string = row.vendor_inventory_string || null;
//         const vendor_inventory = row.vendor_inventory
//           ? parseInt(row.vendor_inventory)
//           : null;

//         try {
//           const vendorProduct = await prisma.vendorProduct.findFirst({
//             where: {
//               vendor_sku: vendorSku,
//               vendor_id: VENDOR_ID,
//             },
//           });

//           if (!vendorProduct) {
//             missingCount++;
//             continue;
//           }

//           console.log(`✅ Found vendor product for SKU: ${vendorSku}`);

//           await prisma.vendorProduct.update({
//             where: {
//               id: vendorProduct.id,
//             },
//             data: {
//               vendor_inventory,
//               vendor_inventory_string,
//             },
//           });

//           updatedCount++;
          
//           // Log progress every 5 products
//           if (updatedCount % 5 === 0) {
//             console.log(`📦 Progress: ${updatedCount} products updated, ${missingCount} missing...`);
//           }
//         } catch (error) {
//           console.error(`❌ Error updating SKU ${vendorSku}:`, error.message);
//         }
//       }

//       // Release connection between batches
//       if (i + BATCH_SIZE < enrichedInventory.length) {
//         await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between batches
//       }
//     }

//     console.log(`\n✅ Done!
//   ➕ Updated: ${updatedCount}
//   ❌ Missing SKUs: ${missingCount}`);
//   } catch (error) {
//     console.error("Fatal error during inventory update:", error);
//   } finally {
//     await prisma.$disconnect();
//   }
// };

// updateInventory();
