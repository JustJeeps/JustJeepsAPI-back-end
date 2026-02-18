/* prisma/seeds/seed-individual/seed-keystone-ftp-2.js */

const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const prisma = new PrismaClient();

// ---- CONFIG ----
const VENDOR_ID = 1; // Keystone
const BASE_DIR = path.join(__dirname, "../api-calls/keystone_files");

const INVENTORY_FILE = path.join(BASE_DIR, "Inventory.csv");
const SPECIAL_ORDER_FILE = path.join(BASE_DIR, "SpecialOrder.csv");

// Insert + lookup tuning
const BATCH_SIZE_INSERT = 5000; // like Quad
const BATCH_SIZE_CODES = 10000; // chunk size for Product lookup
const LOG_EVERY_BATCH = 5;

// ---- helpers ----
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/\$/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanCsvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).trim();
  if (!s) return "";
  // Excel-style formulas: ="123" -> 123
  if (/^=\s*".*"$/.test(s)) s = s.replace(/^=\s*"(.*)"$/, "$1");
  // Strip wrapping quotes if any remain
  return s.replace(/^"+|"+$/g, "").trim();
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "~?";
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `~${m}m ${s}s`;
}

// Prefer SKUs that do NOT end with a dash when there's a collision on the same keystone_code
function preferSku(currentSku, candidateSku) {
  if (!currentSku) return candidateSku;
  const curEndsWithDash = currentSku.endsWith("-");
  const candEndsWithDash = candidateSku.endsWith("-");
  if (curEndsWithDash && !candEndsWithDash) return candidateSku;
  return currentSku;
}

async function withRetry(fn, label = "db") {
  const max = 5;
  let lastErr;
  for (let i = 1; i <= max; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 250 * i * i;
      console.warn(`⚠️ ${label} failed (attempt ${i}/${max}) — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Normalize CSV row field access (handles slight header variations).
 */
function getField(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  return undefined;
}

/**
 * Decide which row wins when the same VCPN appears multiple times (within a file or across files).
 *
 * Priority:
 *  1) Having a numeric cost is required (rows without cost are weak)
 *  2) Prefer Inventory over SpecialOrder
 *  3) Prefer rows with qty (if available)
 *  4) Higher qty wins
 *
 * (You can tweak this easily if you want SpecialOrder to override Inventory cost.)
 */
function scoreRecord(rec) {
  // source: higher is better
  const sourceScore = rec.source === "Inventory.csv" ? 2 : 1;

  const hasCost = isNum(rec.cost) ? 1 : 0;
  const hasQty = isNum(rec.qty) ? 1 : 0;
  const qtyVal = isNum(rec.qty) ? rec.qty : -1;

  // tuple score
  return [hasCost, sourceScore, hasQty, qtyVal];
}

function isScoreBetter(a, b) {
  // returns true if score(a) > score(b)
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Stream a CSV and merge into invMap keyed by VCPN.
 * Memory-safe: only invMap is kept.
 */
async function streamIntoMap(filePath, invMap, summary) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileName = path.basename(filePath);

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (r) => {
        summary.rows++;

        // Your current logs show VCPN always present, but keep safe
        const VCPN = cleanCsvField(getField(r, "VCPN"));

        // Keystone files typically have VendorPart, DealerPrice, TotalQty
        const vendorPart = cleanCsvField(getField(r, "VendorPart", "Vendor Part"));
        const vendorCode = cleanCsvField(getField(r, "VendorCode", "Vendor Code"));
        const manufacturerPartNo = cleanCsvField(
          getField(r, "ManufacturerPartNo", "Manufacturer Part No", "MfgPartNo")
        );
        const cost = toNumber(getField(r, "DealerPrice", "Dealer Price", "Cost", "Price"));
        const qty = toNumber(getField(r, "TotalQty", "Total Qty", "Qty", "QTY", "Inventory"));

        if (VCPN) summary.haveVCPN++;
        else summary.emptyVCPN++;

        if (!VCPN) return;

        const rec = {
          code: VCPN,
          vendorSku: vendorPart || VCPN,
          vendorCode,
          manufacturerPartNo,
          cost,
          qty: isNum(qty) ? qty : null,
          source: fileName,
        };

        const existing = invMap.get(VCPN);
        if (!existing) {
          invMap.set(VCPN, rec);
          return;
        }

        // merge: keep best record by scoring
        const sNew = scoreRecord(rec);
        const sOld = scoreRecord(existing);

        if (isScoreBetter(sNew, sOld)) {
          invMap.set(VCPN, rec);
        }
      })
      .on("end", () => resolve())
      .on("error", reject);
  });
}

/**
 * Parse Inventory + SpecialOrder using streaming aggregation.
 */
async function loadKeystoneMapFromCSVs() {
  console.log("🚀 Seeding Keystone vendor products from local CSVs...");

  const t0 = nowMs();

  const invMap = new Map(); // VCPN -> best record

  const invSummary = {
    file: "Inventory.csv",
    rows: 0,
    haveVCPN: 0,
    builtFromVendorPart: 0,
    emptyVCPN: 0,
  };

  const soSummary = {
    file: "SpecialOrder.csv",
    rows: 0,
    haveVCPN: 0,
    builtFromVendorPart: 0,
    emptyVCPN: 0,
  };

  // Stream Inventory first (so it naturally “wins” on ties via sourceScore)
  await streamIntoMap(INVENTORY_FILE, invMap, invSummary);
  // Then SpecialOrder
  await streamIntoMap(SPECIAL_ORDER_FILE, invMap, soSummary);

  const t1 = nowMs();

  console.log("🧪 VCPN extraction summary per file:", [invSummary, soSummary]);
  console.log(`📦 Total rows parsed: ${(invSummary.rows + soSummary.rows).toLocaleString()}`);
  console.log(`✅ Unique VCPN codes after merge: ${invMap.size.toLocaleString()}`);
  console.log(`parse CSVs: ${((t1 - t0) / 1000).toFixed(3)}s`);

  return invMap;
}

async function loadProductsByKeystoneCodes(allCodes) {
  console.log(`🔎 Loading Products by keystone_code for ${allCodes.length.toLocaleString()} codes...`);

  const t0 = nowMs();
  const codeToSku = new Map();
  let collisionsResolved = 0;

  for (let i = 0; i < allCodes.length; i += BATCH_SIZE_CODES) {
    const chunk = allCodes.slice(i, i + BATCH_SIZE_CODES);

    const products = await withRetry(
      () =>
        prisma.product.findMany({
          where: { keystone_code: { in: chunk } },
          select: { sku: true, keystone_code: true },
        }),
      "product.findMany"
    );

    for (const p of products) {
      const code = p.keystone_code;
      if (!code) continue;

      const current = codeToSku.get(code);
      const chosen = preferSku(current, p.sku);
      if (current && chosen !== current) collisionsResolved++;
      codeToSku.set(code, chosen);
    }
  }

  const t1 = nowMs();
  console.log(`ℹ️ Resolved ${collisionsResolved} duplicate keystone_code collisions (prefer non-dash SKUs).`);
  console.log(`fetch products mapping: ${((t1 - t0) / 1000).toFixed(3)}s`);

  return codeToSku;
}

async function seedKeystoneBulk() {
  const totalStart = nowMs();

  // 1) Stream both CSVs into a compact map (2.6M input safe)
  const invMap = await loadKeystoneMapFromCSVs();
  const codes = Array.from(invMap.keys());

  // Build fallback codes for Keystone quirks (VendorCode + ManufacturerPartNo)
  const fallbackCodeByVcpn = new Map();
  const fallbackCodes = [];
  for (const [vcpn, rec] of invMap.entries()) {
    if (!rec.vendorCode || !rec.manufacturerPartNo) continue;
    const fallback = `${rec.vendorCode}${rec.manufacturerPartNo}`;
    if (fallback && fallback !== vcpn) {
      fallbackCodeByVcpn.set(vcpn, fallback);
      fallbackCodes.push(fallback);
    }
  }

  const allCodes = codes.concat(fallbackCodes);

  // 2) Load Products mapping by keystone_code (chunked)
  const codeToSku = await loadProductsByKeystoneCodes(allCodes);

  // 3) Build VendorProduct rows (unique by code due to invMap)
  const rowsToInsert = [];
  let matched = 0;
  let missing = 0;
  let skippedNoCost = 0;

  for (const code of codes) {
    let sku = codeToSku.get(code);
    if (!sku) {
      const fallback = fallbackCodeByVcpn.get(code);
      if (fallback) sku = codeToSku.get(fallback);
    }
    if (!sku) {
      missing++;
      continue;
    }

    const rec = invMap.get(code);
    if (!rec) continue;

    if (!isNum(rec.cost)) {
      skippedNoCost++;
      continue;
    }

    matched++;
    rowsToInsert.push({
      product_sku: sku,
      vendor_id: VENDOR_ID,
      vendor_sku: rec.vendorSku || code,
      vendor_cost: rec.cost,
      vendor_inventory: isNum(rec.qty) ? rec.qty : null,
    });
  }

  console.log(`✅ Matched ${matched.toLocaleString()}/${codes.length.toLocaleString()} product codes`);
  console.log(`⚠️ Missing products: ${missing.toLocaleString()}`);
  console.log(`⚠️ Skipped (no cost): ${skippedNoCost.toLocaleString()}`);

  // 4) Delete old vendor products first (same as your Quadratec script)
  console.time("delete old vendor_id=1");
  await withRetry(() => prisma.vendorProduct.deleteMany({ where: { vendor_id: VENDOR_ID } }), "vendorProduct.deleteMany");
  console.timeEnd("delete old vendor_id=1");

  // 5) Insert in batches w/ ETA + short transactions
  console.time("insert vendorProducts");
  const start = nowMs();
  const total = rowsToInsert.length;

  const batches = Math.ceil(total / BATCH_SIZE_INSERT);
  let inserted = 0;

  for (let b = 0; b < batches; b++) {
    const chunk = rowsToInsert.slice(b * BATCH_SIZE_INSERT, (b + 1) * BATCH_SIZE_INSERT);

    await withRetry(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.vendorProduct.createMany({
            data: chunk,
          });
        }),
      "vendorProduct.createMany(tx)"
    );

    inserted += chunk.length;

    if ((b + 1) % LOG_EVERY_BATCH === 0 || b === batches - 1) {
      const elapsedSec = (nowMs() - start) / 1000;
      const rps = elapsedSec > 0 ? inserted / elapsedSec : 0;
      const remaining = total - inserted;
      const eta = rps > 0 ? remaining / rps : Infinity;

      console.log(
        `Batch ${b + 1}/${batches} | ${inserted}/${total} rows | ${rps.toFixed(1)} rows/s | ETA ${formatEta(eta)}`
      );
    }
  }

  console.timeEnd("insert vendorProducts");

  const count = await prisma.vendorProduct.count({ where: { vendor_id: VENDOR_ID } });
  const totalSec = ((nowMs() - totalStart) / 1000).toFixed(2);

  console.log(`✅ VendorProduct count for Keystone (vendor_id=${VENDOR_ID}): ${count}`);
  console.log(`✅ Keystone vendor products seeded successfully.`);
  console.log(`seed-keystone-ftp2 total: ${totalSec}s`);
}

(async () => {
  try {
    await seedKeystoneBulk();
  } catch (e) {
    console.error("❌ Seed failed:", e);
  } finally {
    await prisma.$disconnect();
  }
})();



// /* eslint-disable no-console */
// const { performance } = require("perf_hooks");
// const path = require("path");
// const fs = require("fs");

// const parseKeystoneLocal = require("../api-calls/parse-keystone-local");
// const prisma = require("../../../lib/prisma");

// /**
//  * CONFIG
//  * Adjust VENDOR_CONNECT to uniquely identify Keystone in your Vendor table.
//  * If id:1 isn’t correct, switch to something like { code: "KEYSTONE" } or { name: "Keystone" }.
//  */
// const KEYSTONE_DIR = path.resolve(__dirname, "../api-calls/keystone_files");
// const VENDOR_CONNECT = { id: 1 };              // <-- change if needed
// const CLEAR_OLD_FIRST = false;                 // delete all Keystone rows then recreate
// const UPDATE_OR_CREATE_BY_VENDOR_SKU = true;   // API-style replace logic

// // Logging
// const VERBOSE_ROW_LOGS = true;                // set true to log each create/update to console
// const PROGRESS_EVERY = 2000;                   // progress tick size
// const LOG_TO_FILE = true;                      // write a CSV of every create/update
// const LOG_DIR = path.resolve(__dirname, "../logs");

// /** helpers */
// const clean = (s) => {
//   if (s == null) return "";
//   let t = String(s).trim();
//   if (/^=\s*".*"$/.test(t)) t = t.replace(/^=\s*"(.*)"$/, "$1"); // ="123" -> 123
//   return t.replace(/^"+|"+$/g, "").trim();
// };
// const toFloatOrNull = (v) => {
//   if (v === null || v === undefined || v === "") return null;
//   const n = parseFloat(String(v).replace(/,/g, ""));
//   return Number.isNaN(n) ? null : n;
// };
// const toInt = (v) => {
//   if (v === null || v === undefined || v === "") return 0;
//   const n = parseInt(String(v).replace(/,/g, ""), 10);
//   return Number.isNaN(n) ? 0 : n;
// };
// const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// const withDbRetry = async (operation, label) => {
//   const maxAttempts = 2;
//   let attempt = 0;

//   while (true) {
//     try {
//       return await operation();
//     } catch (err) {
//       const code = err && err.code;
//       const message = err && err.message ? String(err.message) : "";
//       const isClosed = code === "P1017" || /Server has closed the connection/i.test(message);

//       attempt += 1;
//       if (!isClosed || attempt >= maxAttempts) {
//         throw err;
//       }

//       console.warn(`⚠️ ${label} failed (${code || "connection error"}); reconnecting and retrying...`);
//       try {
//         await prisma.$disconnect();
//       } catch (disconnectError) {
//         // ignore disconnect errors and retry connection
//       }
//       await prisma.$connect();
//     }
//   }
// };

// // CSV log helpers
// function ensureLogDir() {
//   if (LOG_TO_FILE && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// }
// function openCsvLog() {
//   if (!LOG_TO_FILE) return null;
//   ensureLogDir();
//   const ts = new Date().toISOString().replace(/[:.]/g, "-");
//   const filePath = path.join(LOG_DIR, `keystone-local-${ts}.csv`);
//   const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
//   stream.write("action,vendor_sku,product_sku,keystone_code,vendor_cost,vendor_inventory\n");
//   return { stream, filePath };
// }
// function writeCsv(streamObj, row) {
//   if (!LOG_TO_FILE || !streamObj) return;
//   const { stream } = streamObj;
//   const esc = (v) => {
//     if (v === null || v === undefined) return "";
//     const s = String(v);
//     return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
//   };
//   stream.write(
//     [
//       esc(row.action),
//       esc(row.vendor_sku),
//       esc(row.product_sku),
//       esc(row.keystone_code),
//       esc(row.vendor_cost),
//       esc(row.vendor_inventory),
//     ].join(",") + "\n"
//   );
// }

// (async function run() {
//   console.log("🚀 Seeding Keystone vendor products from local CSVs...");
//   const start = performance.now();

//   let created = 0;
//   let updated = 0;
//   let missingProduct = 0;
//   let deduped = 0;
//   let processed = 0;

//   const csvLog = openCsvLog();

//   try {
//     await prisma.$connect();
//     // 1) read local files
//     const fileSets = await parseKeystoneLocal(KEYSTONE_DIR);

//     // 2) normalize rows (VCPN = Keystone code)
//     const rows = [];
//     for (const f of fileSets) {
//       for (const r of f.data || []) {
//         const VCPN = clean(r.vcPn ?? r.VCPN ?? r.VcPn);
//         if (!VCPN) continue;
//         rows.push({
//           VCPN,
//           cost: toFloatOrNull(r.cost),
//           totalQty: toInt(r.totalQty),
//         });
//       }
//     }
//     console.log(`📦 Total rows parsed: ${rows.length}`);
//     if (rows.length === 0) {
//       console.log("ℹ️ No rows found. Check CSV headers & path:", KEYSTONE_DIR);
//       if (csvLog) csvLog.stream.end();
//       await prisma.$disconnect();
//       return;
//     }

//     // 3) batch-load products by keystone_code
//     const uniqueCodes = [...new Set(rows.map((x) => x.VCPN))];
//     console.log(`🔎 Loading Products by keystone_code for ${uniqueCodes.length} codes...`);

//     const products = await withDbRetry(
//       () => prisma.product.findMany({
//         where: { keystone_code: { in: uniqueCodes } },
//         select: { keystone_code: true, sku: true },
//       }),
//       "product.findMany"
//     );

// // prefer SKUs that don't end with a hyphen
// const endsWithDash = (s) => /-\s*$/.test(s);

// const productByKeystone = new Map();
// let duplicateKeystoneCodes = 0;

// for (const p of products) {
//   const key = p.keystone_code;
//   const candidate = p.sku;
//   const current = productByKeystone.get(key);

//   if (!current) {
//     productByKeystone.set(key, candidate);
//     continue;
//   }
//   duplicateKeystoneCodes++;

//   const candBad = endsWithDash(candidate);
//   const curBad = endsWithDash(current);

//   // If current is "bad" (ends with '-') and candidate is "good", replace.
//   if (curBad && !candBad) {
//     productByKeystone.set(key, candidate);
//   }
//   // else: keep the existing selection (first good wins; if both bad, first wins)
// }

// if (duplicateKeystoneCodes) {
//   console.log(`ℹ️ Resolved ${duplicateKeystoneCodes} duplicate keystone_code collisions (prefer non-dash SKUs).`);
// }

//     // const products = await prisma.product.findMany({
//     //   where: { keystone_code: { in: uniqueCodes } },
//     //   select: { keystone_code: true, sku: true },
//     // });
//     // const productByKeystone = new Map(products.map((p) => [p.keystone_code, p.sku]));
//     console.log(`✅ Matched ${products.length}/${uniqueCodes.length} product codes`);

//     // 4) optional clear
//     if (CLEAR_OLD_FIRST) {
//       await withDbRetry(
//         () => prisma.vendorProduct.deleteMany({
//           where: { vendor: { is: VENDOR_CONNECT } }, // relation filter
//         }),
//         "vendorProduct.deleteMany"
//       );
//       console.log("🗑️ Deleted existing Keystone vendor products");
//     }

//     // 5) process rows in batches to avoid connection pool exhaustion
//     const BATCH_SIZE = 100;
//     for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
//       const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
      
//       for (const r of batch) {
//         processed++;
//         const { VCPN, cost, totalQty } = r;
//         const sku = productByKeystone.get(VCPN);
//         if (!sku) {
//           if (missingProduct < 25) console.log(`⚠️ Missing product for Keystone code ${VCPN}`);
//           missingProduct++;
//           continue;
//         }

//       const vendorSku = VCPN; // API logic: vendor_sku must be VCPN

//       if (CLEAR_OLD_FIRST) {
//         // Create-only; your schema requires vendor_cost on create => skip if missing
//         if (!isNum(cost)) {
//           if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
//           continue;
//         }
//         await prisma.vendorProduct.create({
//           data: {
//             vendor_sku: vendorSku,
//             vendor_cost: cost,
//             ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
//             vendor: { connect: VENDOR_CONNECT },
//             product: { connect: { sku } },
//           },
//         });
//         created++;
//         writeCsv(csvLog, {
//           action: "CREATE",
//           vendor_sku: vendorSku,
//           product_sku: sku,
//           keystone_code: VCPN,
//           vendor_cost: cost,
//           vendor_inventory: totalQty,
//         });
//         if (VERBOSE_ROW_LOGS) console.log(`[CREATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
//         continue;
//       }

//       if (UPDATE_OR_CREATE_BY_VENDOR_SKU) {
//         // find existing by (vendor relation + vendor_sku)
//         const existing = await withDbRetry(
//           () => prisma.vendorProduct.findMany({
//             where: { vendor_sku: vendorSku, vendor: { is: VENDOR_CONNECT } },
//             orderBy: { id: "desc" },
//             select: { id: true },
//           }),
//           "vendorProduct.findMany"
//         );

//         if (existing.length > 0) {
//           const keep = existing[0];
//           const toDeleteIds = existing.slice(1).map((x) => x.id);
//           if (toDeleteIds.length) {
//             await withDbRetry(
//               () => prisma.vendorProduct.deleteMany({ where: { id: { in: toDeleteIds } } }),
//               "vendorProduct.deleteMany"
//             );
//             deduped += toDeleteIds.length;
//           }

//           // UPDATE: omit vendor_cost if not numeric (don’t send null)
//           const data = {
//             vendor_sku: vendorSku,
//             ...(isNum(cost) ? { vendor_cost: cost } : {}),
//             ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
//             vendor: { connect: VENDOR_CONNECT },
//             product: { connect: { sku } },
//           };
//           await withDbRetry(
//             () => prisma.vendorProduct.update({ where: { id: keep.id }, data }),
//             "vendorProduct.update"
//           );
//           updated++;
//           writeCsv(csvLog, {
//             action: "UPDATE",
//             vendor_sku: vendorSku,
//             product_sku: sku,
//             keystone_code: VCPN,
//             vendor_cost: isNum(cost) ? cost : "",
//             vendor_inventory: isNum(totalQty) ? totalQty : "",
//           });
//           if (VERBOSE_ROW_LOGS) console.log(`[UPDATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
//         } else {
//           // CREATE: vendor_cost required on create => skip if missing
//           if (!isNum(cost)) {
//             if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
//             continue;
//           }
//           await withDbRetry(
//             () => prisma.vendorProduct.create({
//               data: {
//                 vendor_sku: vendorSku,
//                 vendor_cost: cost,
//                 ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
//                 vendor: { connect: VENDOR_CONNECT },
//                 product: { connect: { sku } },
//               },
//             }),
//             "vendorProduct.create"
//           );
//           created++;
//           writeCsv(csvLog, {
//             action: "CREATE",
//             vendor_sku: vendorSku,
//             product_sku: sku,
//             keystone_code: VCPN,
//             vendor_cost: cost,
//             vendor_inventory: totalQty,
//           });
//           if (VERBOSE_ROW_LOGS) console.log(`[CREATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
//         }
//       } else {
//         // fallback: find by both relations
//         const existing = await withDbRetry(
//           () => prisma.vendorProduct.findFirst({
//             where: { vendor: { is: VENDOR_CONNECT }, product: { is: { sku } } },
//             select: { id: true },
//           }),
//           "vendorProduct.findFirst"
//         );

//         if (existing) {
//           const data = {
//             vendor_sku: vendorSku,
//             ...(isNum(cost) ? { vendor_cost: cost } : {}),
//             ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
//             vendor: { connect: VENDOR_CONNECT },
//             product: { connect: { sku } },
//           };
//           await withDbRetry(
//             () => prisma.vendorProduct.update({ where: { id: existing.id }, data }),
//             "vendorProduct.update"
//           );
//           updated++;
//           writeCsv(csvLog, {
//             action: "UPDATE",
//             vendor_sku: vendorSku,
//             product_sku: sku,
//             keystone_code: VCPN,
//             vendor_cost: isNum(cost) ? cost : "",
//             vendor_inventory: isNum(totalQty) ? totalQty : "",
//           });
//         } else {
//           if (!isNum(cost)) {
//             if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
//             continue;
//           }
//           await withDbRetry(
//             () => prisma.vendorProduct.create({
//               data: {
//                 vendor_sku: vendorSku,
//                 vendor_cost: cost,
//                 ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
//                 vendor: { connect: VENDOR_CONNECT },
//                 product: { connect: { sku } },
//               },
//             }),
//             "vendorProduct.create"
//           );
//           created++;
//           writeCsv(csvLog, {
//             action: "CREATE",
//             vendor_sku: vendorSku,
//             product_sku: sku,
//             keystone_code: VCPN,
//             vendor_cost: cost,
//             vendor_inventory: totalQty,
//           });
//         }
//       }

//         if (processed % PROGRESS_EVERY === 0) {
//           console.log(`⏳ ${processed} processed · ${created} created · ${updated} updated · ${missingProduct} missing · ${deduped} deduped`);
//         }
//       }

//       // Release connection between batches
//       if (batchStart + BATCH_SIZE < rows.length) {
//         await new Promise(resolve => setTimeout(resolve, 100));
//       }
//     }

//     const secs = ((performance.now() - start) / 1000).toFixed(2);
//     console.log(`
// ✅ Keystone (LOCAL CSV) seeding done!
// 📊 Created: ${created}
// 📊 Updated: ${updated}
// 🧩 Missing product matches: ${missingProduct}
// 🧹 De-duped removed: ${deduped}
// ⏱️ Time: ${secs}s
//     `);

//     if (csvLog) {
//       console.log(`📝 Detailed CSV log: ${csvLog.filePath}`);
//       csvLog.stream.end();
//     }
//   } catch (e) {
//     console.error("❌ Seed failed:", e);
//     if (csvLog) csvLog.stream.end();
//   } finally {
//     await prisma.$disconnect();
//   }
// })();
