// const fs = require("fs");
// const path = require("path");

// const prisma = require("../../../lib/prisma");
// const { fetchMeyerItems } = require("../api-calls/meyer-api.js");

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// function nowIso() {
//   return new Date().toISOString();
// }

// function formatNumber(n) {
//   return Number(n).toLocaleString("en-US");
// }

// function safeFloat(v) {
//   if (v === null || v === undefined || v === "") return null;
//   const x = Number(v);
//   return Number.isFinite(x) ? x : null;
// }

// function escapeSqlString(value) {
//   return String(value).replace(/\\/g, "\\\\").replace(/'/g, "''");
// }

// function buildValuesSql(rows) {
//   return rows
//     .map((r) => {
//       const vendorId = Number(r.vendor_id);
//       const vendorSku = `'${escapeSqlString(r.vendor_sku)}'`;
//       const productSku = `'${escapeSqlString(r.product_sku)}'`;

//       const cost = r.vendor_cost === null ? "NULL" : Number(r.vendor_cost);
//       const inv = r.vendor_inventory === null ? "NULL" : Number(r.vendor_inventory);

//       const partStatus =
//         r.partStatus_meyer === null || r.partStatus_meyer === undefined || r.partStatus_meyer === ""
//           ? "NULL"
//           : `'${escapeSqlString(r.partStatus_meyer)}'`;

//       const len = r.meyer_length === null ? "NULL" : Number(r.meyer_length);
//       const wid = r.meyer_width === null ? "NULL" : Number(r.meyer_width);
//       const hei = r.meyer_height === null ? "NULL" : Number(r.meyer_height);
//       const wgt = r.meyer_weight === null ? "NULL" : Number(r.meyer_weight);

//       return `(${vendorId},${vendorSku},${productSku},${cost},${inv},${partStatus},${len},${wid},${hei},${wgt})`;
//     })
//     .join(",\n");
// }

// function formatDuration(ms) {
//   const s = Math.floor(ms / 1000);
//   const h = Math.floor(s / 3600);
//   const m = Math.floor((s % 3600) / 60);
//   const ss = s % 60;
//   if (h > 0) return `${h}h ${m}m ${ss}s`;
//   if (m > 0) return `${m}m ${ss}s`;
//   return `${ss}s`;
// }

// function calcRate(processed, startTs) {
//   const elapsedSec = (Date.now() - startTs) / 1000;
//   if (elapsedSec <= 0) return 0;
//   return processed / elapsedSec;
// }

// function calcEtaSec(remaining, rate) {
//   if (!rate || rate <= 0) return null;
//   return remaining / rate;
// }

// function sampleVendorRows(rows, count = 5) {
//   const seen = new Set();
//   const out = [];

//   for (const r of rows) {
//     if (!r || !r.vendor_sku) continue;
//     if (seen.has(r.vendor_sku)) continue;
//     seen.add(r.vendor_sku);

//     const cost = r.vendor_cost === null || r.vendor_cost === undefined ? "null" : r.vendor_cost;
//     const inv = r.vendor_inventory === null || r.vendor_inventory === undefined ? "null" : r.vendor_inventory;
//     out.push(`${r.vendor_sku} (price=${cost} inv=${inv})`);

//     if (out.length >= count) break;
//   }

//   return out;
// }

// async function seedMeyerVendorProducts() {
//   const vendorId = 2; // ✅ Meyer vendor_id=2
//   const startedAt = Date.now();
//   console.time("seed-meyer total");

//   const checkpointPath = path.join(__dirname, "..", "logs", "seed-meyer.checkpoint.json");
//   const resumeEnabled =
//     process.env.SEED_MEYER_RESUME === "1" || process.env.SEED_MEYER_RESUME === "true";

//   const batchSize = Number(process.env.SEED_MEYER_DB_BATCH_SIZE || 500);
//   const checkpointEvery = Number(process.env.SEED_MEYER_CHECKPOINT_EVERY || 2000);

//   const concurrency = Number(process.env.MEYER_CONCURRENCY || 6);
//   const apiTimeoutMs = Number(process.env.MEYER_TIMEOUT_MS || 30000);

//   // NEW: heartbeat logs
//   const logEverySec = Number(process.env.SEED_MEYER_LOG_EVERY_SEC || 15);
//   const logEveryItems = Number(process.env.SEED_MEYER_LOG_EVERY_ITEMS || 2000);

//   let resumeIndex = 0;
//   let created = 0;
//   let updated = 0;
//   let apiOk = 0;
//   let apiFail = 0;
//   let skippedNoProduct = 0;
//   let skippedNoData = 0;

//   let lastCheckpointIndex = -1;
//   let lastCheckpointItem = null;

//   if (resumeEnabled && fs.existsSync(checkpointPath)) {
//     try {
//       const raw = fs.readFileSync(checkpointPath, "utf8");
//       const ck = JSON.parse(raw);
//       if (typeof ck.lastIndex === "number") resumeIndex = ck.lastIndex + 1;
//       if (typeof ck.created === "number") created = ck.created;
//       if (typeof ck.updated === "number") updated = ck.updated;
//       if (typeof ck.apiOk === "number") apiOk = ck.apiOk;
//       if (typeof ck.apiFail === "number") apiFail = ck.apiFail;
//       if (typeof ck.skippedNoProduct === "number") skippedNoProduct = ck.skippedNoProduct;
//       if (typeof ck.skippedNoData === "number") skippedNoData = ck.skippedNoData;

//       console.log(
//         `🔁 Resuming from checkpoint index ${resumeIndex} (lastItemNumber=${ck.lastItemNumber || "n/a"})`
//       );
//     } catch {
//       console.warn("⚠️ Could not read checkpoint file. Starting from scratch.");
//     }
//   }

//   const writeCheckpoint = (lastIndex, lastItemNumber) => {
//     const payload = {
//       lastIndex,
//       lastItemNumber,
//       created,
//       updated,
//       apiOk,
//       apiFail,
//       skippedNoProduct,
//       skippedNoData,
//       updatedAt: nowIso(),
//     };
//     fs.writeFileSync(checkpointPath, JSON.stringify(payload, null, 2), "utf8");
//     lastCheckpointIndex = lastIndex;
//     lastCheckpointItem = lastItemNumber;
//     console.log(
//       `💾 checkpoint saved @ index=${formatNumber(lastIndex)} item=${lastItemNumber} | created=${formatNumber(
//         created
//       )} updated=${formatNumber(updated)}`
//     );
//   };

//   try {
//     console.log(`🚀 Seeding Meyer vendor products (vendor_id=${vendorId}) ...`);

//     console.time("fetch products with meyer_code");
//     const products = await prisma.product.findMany({
//       where: {
//         status: 1,
//         meyer_code: { not: "" },
//       },
//       select: {
//         sku: true,
//         meyer_code: true,
//       },
//     });
//     console.timeEnd("fetch products with meyer_code");
//     console.log(`✅ Product rows with meyer_code: ${formatNumber(products.length)}`);

//     const meyerToProductSku = new Map();
//     for (const p of products) {
//       if (p.meyer_code) meyerToProductSku.set(p.meyer_code, p.sku);
//     }

//     const itemNumbers = Array.from(meyerToProductSku.keys());
//     const total = itemNumbers.length;

//     console.log(`✅ Unique Meyer ItemNumbers to fetch: ${formatNumber(total)}`);
//     console.log(`🔧 API concurrency=${concurrency} timeout=${apiTimeoutMs}ms`);
//     console.log(
//       `🧾 DB batchSize=${batchSize} | apiWindow=${process.env.SEED_MEYER_API_WINDOW || 1200} | checkpointEvery=${checkpointEvery}`
//     );
//     console.log(`📣 Progress logs: every ${logEverySec}s OR every ${formatNumber(logEveryItems)} items`);

//     const apiWindow = Number(process.env.SEED_MEYER_API_WINDOW || 1200);

//     let processed = 0;
//     let windowStart = resumeIndex;

//     let dbBuffer = [];

//     let heartbeatLastTs = Date.now();
//     const startTs = Date.now();

//     const logHeartbeat = (force = false, currentIndex = null, currentItem = null) => {
//       const now = Date.now();
//       const elapsedMs = now - startTs;

//       if (!force && now - heartbeatLastTs < logEverySec * 1000) return;
//       heartbeatLastTs = now;

//       const done = currentIndex !== null ? currentIndex + 1 : windowStart;
//       const remaining = total - done;

//       const rate = calcRate(processed, startTs);
//       const etaSec = calcEtaSec(remaining, rate);

//       console.log(
//         `📍 progress | done=${formatNumber(done)}/${formatNumber(total)} (${(
//           (done / Math.max(total, 1)) *
//           100
//         ).toFixed(2)}%) | processed=${formatNumber(processed)} | rate=${rate.toFixed(
//           2
//         )}/s | ETA ~${etaSec === null ? "n/a" : formatDuration(etaSec * 1000)} | ` +
//           `apiOk=${formatNumber(apiOk)} apiFail=${formatNumber(apiFail)} | skipped(noData)=${formatNumber(
//             skippedNoData
//           )} skipped(noProduct)=${formatNumber(skippedNoProduct)} | ` +
//           `buffer=${formatNumber(dbBuffer.length)} | inserted=${formatNumber(created)} updated=${formatNumber(
//             updated
//           )} | elapsed=${formatDuration(elapsedMs)} | last=${currentItem || lastCheckpointItem || "n/a"}`
//       );
//     };

//     const flushDbBatch = async (rows) => {
//       if (!rows.length) return { inserted: 0, updated: 0, ms: 0 };

//       const valuesSql = buildValuesSql(rows);

//       const sql = `
// WITH incoming(vendor_id, vendor_sku, product_sku, vendor_cost, vendor_inventory, partStatus_meyer, meyer_length, meyer_width, meyer_height, meyer_weight) AS (
//   VALUES
//   ${valuesSql}
// ),
// updated_vp AS (
//   UPDATE "VendorProduct" vp
//   SET
//     vendor_cost = i.vendor_cost,
//     vendor_inventory = i.vendor_inventory,
//     partStatus_meyer = i.partStatus_meyer
//   FROM incoming i
//   WHERE vp.vendor_id = i.vendor_id
//     AND vp.vendor_sku = i.vendor_sku
//   RETURNING vp.id
// ),
// inserted_vp AS (
//   INSERT INTO "VendorProduct"(product_sku, vendor_id, vendor_sku, vendor_cost, vendor_inventory, partStatus_meyer)
//   SELECT
//     i.product_sku,
//     i.vendor_id,
//     i.vendor_sku,
//     i.vendor_cost,
//     i.vendor_inventory,
//     i.partStatus_meyer
//   FROM incoming i
//   LEFT JOIN "VendorProduct" vp
//     ON vp.vendor_id = i.vendor_id
//    AND vp.vendor_sku = i.vendor_sku
//   WHERE vp.id IS NULL
//   RETURNING id
// ),
// updated_p AS (
//   UPDATE "Product" p
//   SET
//     partStatus_meyer = i.partStatus_meyer,
//     meyer_length = i.meyer_length,
//     meyer_width = i.meyer_width,
//     meyer_height = i.meyer_height,
//     meyer_weight = i.meyer_weight
//   FROM incoming i
//   WHERE p.sku = i.product_sku
//   RETURNING p.sku
// )
// SELECT
//   (SELECT COUNT(*) FROM inserted_vp) AS inserted_count,
//   (SELECT COUNT(*) FROM updated_vp) AS updated_count,
//   (SELECT COUNT(*) FROM updated_p) AS updated_products_count;
// `;

//       const t0 = Date.now();

//       const res = await prisma.$transaction(async (tx) => {
//         const out = await tx.$queryRawUnsafe(sql);
//         return out?.[0] || { inserted_count: 0, updated_count: 0, updated_products_count: 0 };
//       });

//       const ms = Date.now() - t0;

//       return {
//         inserted: Number(res.inserted_count || 0),
//         updated: Number(res.updated_count || 0),
//         ms,
//       };
//     };

//     while (windowStart < total) {
//       const windowEnd = Math.min(windowStart + apiWindow, total);
//       const windowItems = itemNumbers.slice(windowStart, windowEnd);

//       const windowNumber = Math.floor(windowStart / apiWindow) + 1;
//       const windowTotal = Math.ceil(total / apiWindow);

//       console.log(
//         `\n🪟 Meyer API window ${windowNumber}/${windowTotal} | items ${formatNumber(windowStart)} → ${formatNumber(
//           windowEnd - 1
//         )} (count=${formatNumber(windowItems.length)})`
//       );

//       const windowFetchStart = Date.now();
//       const windowResponses = await fetchMeyerItems(windowItems, {
//         concurrency,
//         timeoutMs: apiTimeoutMs,
//         maxRetries: Number(process.env.MEYER_RETRY_MAX || 5),
//         baseDelayMs: Number(process.env.MEYER_RETRY_DELAY_MS || 400),
//         minDelayBetweenCallsMs: Number(process.env.MEYER_MIN_DELAY_MS || 0),
//       });
//       const windowFetchMs = Date.now() - windowFetchStart;

//       // Window-level stats
//       let winOk = 0;
//       let winFail = 0;
//       let winBuffered = 0;

//       for (let i = 0; i < windowResponses.length; i++) {
//         const globalIndex = windowStart + i;
//         if (resumeEnabled && globalIndex < resumeIndex) continue;

//         const itemNumber = windowItems[i];
//         const data = windowResponses[i];

//         processed++;

//         if (!data || data.statusCode) {
//           apiFail++;
//           skippedNoData++;
//           winFail++;
//         } else {
//           const row0 = Array.isArray(data) ? data[0] : null;
//           if (!row0 || !row0.ItemNumber) {
//             apiFail++;
//             skippedNoData++;
//             winFail++;
//           } else {
//             apiOk++;
//             winOk++;

//             const productSku = meyerToProductSku.get(row0.ItemNumber);
//             if (!productSku) {
//               skippedNoProduct++;
//             } else {
//               const record = {
//                 product_sku: productSku,
//                 vendor_id: vendorId,
//                 vendor_sku: row0.ItemNumber,
//                 vendor_cost: safeFloat(row0.CustomerPrice),
//                 vendor_inventory: safeFloat(row0.QtyAvailable),
//                 partStatus_meyer: row0.PartStatus || null,

//                 meyer_length: safeFloat(row0.Length),
//                 meyer_width: safeFloat(row0.Width),
//                 meyer_height: safeFloat(row0.Height),
//                 meyer_weight: safeFloat(row0.Weight),
//               };

//               if (record.vendor_cost === null) {
//                 skippedNoData++;
//               } else {
//                 dbBuffer.push(record);
//                 winBuffered++;
//                 winOk++; // still ok, but this keeps ok consistent either way
//                 winBuffered++; // (don’t worry, just logs)
//               }
//             }
//           }
//         }

//         // Heartbeat logs
//         if (processed % logEveryItems === 0) {
//           logHeartbeat(true, globalIndex, itemNumber);
//         } else {
//           logHeartbeat(false, globalIndex, itemNumber);
//         }

//         // DB flush
//         if (dbBuffer.length >= batchSize) {
//           const sampleRows = sampleVendorRows(dbBuffer, 5);
//           const before = Date.now();
//           const { inserted, updated: upd, ms } = await flushDbBatch(dbBuffer);
//           created += inserted;
//           updated += upd;

//           const done = globalIndex + 1;
//           const remaining = total - done;
//           const rate = calcRate(processed, startTs);
//           const etaSec = calcEtaSec(remaining, rate);

//           console.log(
//             `🧱 DB flush | done=${formatNumber(done)}/${formatNumber(total)} | buffer=${formatNumber(
//               dbBuffer.length
//             )} | inserted=${inserted} updated=${upd} | flush=${ms}ms | totalInserted=${formatNumber(
//               created
//             )} totalUpdated=${formatNumber(updated)} | ETA ~${etaSec === null ? "n/a" : formatDuration(etaSec * 1000)}`
//           );
//           if (sampleRows.length) {
//             console.log(`🔎 sample vendor_sku: ${sampleRows.join(", ")}`);
//           }

//           dbBuffer = [];

//           // tiny yield so logs stay readable
//           await sleep(5);
//         }

//         // checkpoint
//         if (checkpointEvery > 0 && (processed % checkpointEvery === 0 || globalIndex === total - 1)) {
//           writeCheckpoint(globalIndex, itemNumber);
//         }
//       }

//       console.log(
//         `✅ window ${windowNumber}/${windowTotal} done | fetch=${formatDuration(windowFetchMs)} | winOk=${formatNumber(
//           winOk
//         )} winFail=${formatNumber(winFail)} | bufferNow=${formatNumber(dbBuffer.length)}`
//       );

//       windowStart = windowEnd;
//     }

//     // final flush
//     if (dbBuffer.length) {
//       const sampleRows = sampleVendorRows(dbBuffer, 5);
//       const { inserted, updated: upd, ms } = await flushDbBatch(dbBuffer);
//       created += inserted;
//       updated += upd;
//       console.log(
//         `🧱 FINAL DB flush | buffer=${formatNumber(dbBuffer.length)} | inserted=${inserted} updated=${upd} | flush=${ms}ms`
//       );
//       if (sampleRows.length) {
//         console.log(`🔎 sample vendor_sku: ${sampleRows.join(", ")}`);
//       }
//       dbBuffer = [];
//     }

//     const finalCount = await prisma.vendorProduct.count({ where: { vendor_id: vendorId } });
//     console.log(`✅ VendorProduct count for Meyer (vendor_id=${vendorId}): ${formatNumber(finalCount)}`);

//     console.log(
//       `✅ Meyer seed completed.\n` +
//         `API ok=${formatNumber(apiOk)} fail=${formatNumber(apiFail)}\n` +
//         `Inserted=${formatNumber(created)} Updated=${formatNumber(updated)}\n` +
//         `Skipped: noData=${formatNumber(skippedNoData)} noProduct=${formatNumber(skippedNoProduct)}`
//     );

//     // final heartbeat
//     logHeartbeat(true, total - 1, lastCheckpointItem);
//   } catch (err) {
//     console.error("❌ seed-meyer failed:", err);
//     process.exitCode = 1;
//   } finally {
//     await prisma.$disconnect();
//     console.timeEnd("seed-meyer total");
//     const mins = ((Date.now() - startedAt) / 60000).toFixed(2);
//     console.log(`seed-meyer finished in ${mins} minutes.`);
//   }
// }

// seedMeyerVendorProducts();
// module.exports = seedMeyerVendorProducts;

const meyerApi = require("../api-calls/meyer-api.js");

const prisma = require("../../../lib/prisma");

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

function normalizeMeyerLookupKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function resolveMeyerProductSku(map, normalizedMap, itemNumber) {
  const raw = String(itemNumber || "").trim();
  if (!raw) return null;
  if (map.has(raw)) return map.get(raw);

  const normalizedKey = normalizeMeyerLookupKey(raw);
  if (normalizedKey && normalizedMap.has(normalizedKey)) {
    return normalizedMap.get(normalizedKey);
  }

  const normalized = normalizeBajaVendorPart(raw);
  if (normalized && map.has(normalized)) return map.get(normalized);

  return null;
}

function shouldRemoveMeyerVendor(item) {
  const partStatus = String(item?.PartStatus || "").trim().toLowerCase();
  const qtyAvailable = safeFloat(item?.QtyAvailable);
  return partStatus === "discontinued" && qtyAvailable === 0;
}

function parseKeepDiscontinuedZeroSkus() {
  // Keep this intentionally narrow; env var allows explicit additions when needed.
  const defaultSkus = ["BAJ-447723"];
  const fromEnv = String(process.env.SEED_MEYER_KEEP_DISCONTINUED_ZERO_SKUS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return new Set(
    [...defaultSkus, ...fromEnv].map((sku) => String(sku || "").trim().toUpperCase())
  );
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

      const cost = row.vendor_cost === null ? "NULL" : Number(row.vendor_cost);
      const inv = row.vendor_inventory === null ? "NULL" : Number(row.vendor_inventory);

      const partStatus =
        row.partStatus_meyer === null || row.partStatus_meyer === undefined || row.partStatus_meyer === ""
          ? "NULL"
          : `'${escapeSqlString(row.partStatus_meyer)}'`;

      const len = row.meyer_length === null ? "NULL" : Number(row.meyer_length);
      const wid = row.meyer_width === null ? "NULL" : Number(row.meyer_width);
      const hei = row.meyer_height === null ? "NULL" : Number(row.meyer_height);
      const wgt = row.meyer_weight === null ? "NULL" : Number(row.meyer_weight);

      return `(${vendorId},${vendorSku},${productSku},${cost},${inv},${partStatus},${len},${wid},${hei},${wgt})`;
    })
    .join(",\n");
}

// seed Meyer products
const seedMeyerVendorProducts = async () => {
  const seedStartedAt = Date.now();
  const meyerVendorId = 2;
  const keepDiscontinuedZeroSkuSet = parseKeepDiscontinuedZeroSkus();
  try {
    console.time("seed-meyer total");
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let vendorProductRemovedCount = 0;
    let vendorProductDeleteCandidateSkuCount = 0;
    let vendorProductDeleteRowsBeforeCount = 0;
    let vendorProductRemovedSkus = [];
    const batchSize = Number(process.env.SEED_MEYER_DB_BATCH_SIZE || 500);


    

    // Call MeyerCost and get the processed responses
    const vendorProductsData = await meyerApi();

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
    const normalizedMeyerToProductSku = new Map();
    const ambiguousNormalizedMeyerCodes = new Set();
    for (const product of products) {
      if (product.meyer_code) {
        meyerToProductSku.set(product.meyer_code, product.sku);

        const normalizedMeyerCode = normalizeMeyerLookupKey(product.meyer_code);
        if (normalizedMeyerCode && !ambiguousNormalizedMeyerCodes.has(normalizedMeyerCode)) {
          const existingSku = normalizedMeyerToProductSku.get(normalizedMeyerCode);
          if (!existingSku || existingSku === product.sku) {
            normalizedMeyerToProductSku.set(normalizedMeyerCode, product.sku);
          } else {
            normalizedMeyerToProductSku.delete(normalizedMeyerCode);
            ambiguousNormalizedMeyerCodes.add(normalizedMeyerCode);
          }
        }
      }

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
WITH incoming(vendor_id, vendor_sku, product_sku, vendor_cost, vendor_inventory, partstatus_meyer, meyer_length, meyer_width, meyer_height, meyer_weight) AS (
  VALUES
  ${valuesSql}
),
updated_vp AS (
  UPDATE "VendorProduct" vp
  SET
    vendor_cost = i.vendor_cost,
    vendor_inventory = i.vendor_inventory,
    "partStatus_meyer" = i.partstatus_meyer
  FROM incoming i
  WHERE vp.vendor_id = i.vendor_id
    AND vp.vendor_sku = i.vendor_sku
  RETURNING vp.id
),
inserted_vp AS (
  INSERT INTO "VendorProduct"(product_sku, vendor_id, vendor_sku, vendor_cost, vendor_inventory, "partStatus_meyer")
  SELECT
    i.product_sku,
    i.vendor_id,
    i.vendor_sku,
    i.vendor_cost,
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
          vendor_id: meyerVendorId,
          product_sku: { in: productSkus },
        },
      });

      return Number(res?.count || 0);
    };

    let dbBuffer = [];
    const deleteSkuSet = new Set();

    // Safety cleanup: remove stale Meyer rows that are already discontinued + zero qty in DB,
    // even when the current Meyer payload omits those ItemNumbers.
    const staleDiscontinuedRows = await prisma.$queryRawUnsafe(`
      SELECT product_sku
      FROM "VendorProduct"
      WHERE vendor_id = ${meyerVendorId}
        AND COALESCE(vendor_inventory, 0) = 0
        AND LOWER(TRIM(COALESCE("partStatus_meyer", ''))) = 'discontinued'
    `);

    for (const row of staleDiscontinuedRows) {
      if (row?.product_sku) {
        const normalizedSku = String(row.product_sku).trim().toUpperCase();
        if (!keepDiscontinuedZeroSkuSet.has(normalizedSku)) {
          deleteSkuSet.add(row.product_sku);
        }
      }
    }

    if (staleDiscontinuedRows.length) {
      console.log(
        `Pre-cleanup candidates from existing DB state (discontinued + zero qty): ${staleDiscontinuedRows.length}`
      );
    }

    // Loop through the vendorProductsData array and create/update vendor seproducts
    for (const data of vendorProductsData) {
      // console.log("data", data);
      // console.log("counter", counter);
      try {
        //if data = { statusCode: 500, errorCode: 40501, errorMessage: 'No results found' } skip to next iteration
        if (!data || data.statusCode || !Array.isArray(data) || !data[0]) {
          // console.error(`No results found for vendor_sku`);
          continue; // Skip to next iteration
        }

        const item = data[0];
        const productSku = resolveMeyerProductSku(meyerToProductSku, normalizedMeyerToProductSku, item.ItemNumber);
        if (!productSku) {
          console.error(`Product not found for meyer_code: ${item.ItemNumber}`);
          continue;
        }

        if (shouldRemoveMeyerVendor(item)) {
          const normalizedProductSku = String(productSku).trim().toUpperCase();
          if (!keepDiscontinuedZeroSkuSet.has(normalizedProductSku)) {
            deleteSkuSet.add(productSku);
            dbBuffer = dbBuffer.filter((row) => row.product_sku !== productSku);
            continue;
          }
        }

        const vendorProductData = {
          product_sku: productSku,
          vendor_id: meyerVendorId,
          vendor_sku: item.ItemNumber,
          vendor_cost: safeFloat(item.CustomerPrice),
          vendor_inventory: safeFloat(item.QtyAvailable),
          partStatus_meyer: item.PartStatus,
          meyer_length: safeFloat(item.Length),
          meyer_width: safeFloat(item.Width),
          meyer_height: safeFloat(item.Height),
          meyer_weight: safeFloat(item.Weight),
        };

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
        console.error(`Error processing vendor_sku :`, error);
        // You can choose to continue to the next iteration or handle the error as needed
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
      vendorProductDeleteCandidateSkuCount = deleteSkus.length;

      // Capture exactly which product_sku rows currently exist and are eligible to be deleted now.
      const rowsToDelete = await prisma.vendorProduct.findMany({
        where: {
          vendor_id: meyerVendorId,
          product_sku: { in: deleteSkus },
        },
        select: {
          product_sku: true,
        },
      });
      vendorProductRemovedSkus = rowsToDelete.map((row) => row.product_sku);

      vendorProductDeleteRowsBeforeCount = await prisma.vendorProduct.count({
        where: {
          vendor_id: meyerVendorId,
          product_sku: { in: deleteSkus },
        },
      });

      for (let i = 0; i < deleteSkus.length; i += batchSize) {
        const skuBatch = deleteSkus.slice(i, i + batchSize);
        const deleted = await flushDeleteBatch(skuBatch);
        vendorProductRemovedCount += deleted;
      }
    }

    console.log(`Meyer vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}
      Total discontinued+zero candidate SKUs: ${vendorProductDeleteCandidateSkuCount}
      Total rows matched before delete: ${vendorProductDeleteRowsBeforeCount}
      Total vendor products removed this run (discontinued + zero qty): ${vendorProductRemovedCount}`);

    if (keepDiscontinuedZeroSkuSet.size) {
      console.log(
        `Discontinued+zero keep override active for ${keepDiscontinuedZeroSkuSet.size} SKU(s): ${Array.from(
          keepDiscontinuedZeroSkuSet
        ).join(", ")}`
      );
    }

    console.log(`Removed product_sku list this run (${vendorProductRemovedSkus.length}):`);
    if (vendorProductRemovedSkus.length) {
      for (const sku of vendorProductRemovedSkus) {
        console.log(` - ${sku}`);
      }
    } else {
      console.log(" - none");
    }

  } catch (error) {
    console.error("Error seeding vendor products from Meyer:", error);
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-meyer total");
    const mins = ((Date.now() - seedStartedAt) / 60000).toFixed(2);
    console.log(`seed-meyer finished in ${mins} minutes.`);
  }
};

seedMeyerVendorProducts();
module.exports = seedMeyerVendorProducts;

