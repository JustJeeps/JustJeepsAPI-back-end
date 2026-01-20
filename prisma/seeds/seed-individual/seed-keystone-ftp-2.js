/* eslint-disable no-console */
const { PrismaClient } = require("@prisma/client");
const { performance } = require("perf_hooks");
const path = require("path");
const fs = require("fs");

const parseKeystoneLocal = require("../api-calls/parse-keystone-local");
const prisma = new PrismaClient();

/**
 * CONFIG
 * Adjust VENDOR_CONNECT to uniquely identify Keystone in your Vendor table.
 * If id:1 isn’t correct, switch to something like { code: "KEYSTONE" } or { name: "Keystone" }.
 */
const KEYSTONE_DIR = path.resolve(__dirname, "../api-calls/keystone_files");
const VENDOR_CONNECT = { id: 1 };              // <-- change if needed
const CLEAR_OLD_FIRST = false;                 // delete all Keystone rows then recreate
const UPDATE_OR_CREATE_BY_VENDOR_SKU = true;   // API-style replace logic

// Logging
const VERBOSE_ROW_LOGS = true;                // set true to log each create/update to console
const PROGRESS_EVERY = 2000;                   // progress tick size
const LOG_TO_FILE = true;                      // write a CSV of every create/update
const LOG_DIR = path.resolve(__dirname, "../logs");

/** helpers */
const clean = (s) => {
  if (s == null) return "";
  let t = String(s).trim();
  if (/^=\s*".*"$/.test(t)) t = t.replace(/^=\s*"(.*)"$/, "$1"); // ="123" -> 123
  return t.replace(/^"+|"+$/g, "").trim();
};
const toFloatOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
};
const toInt = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// CSV log helpers
function ensureLogDir() {
  if (LOG_TO_FILE && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}
function openCsvLog() {
  if (!LOG_TO_FILE) return null;
  ensureLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(LOG_DIR, `keystone-local-${ts}.csv`);
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  stream.write("action,vendor_sku,product_sku,keystone_code,vendor_cost,vendor_inventory\n");
  return { stream, filePath };
}
function writeCsv(streamObj, row) {
  if (!LOG_TO_FILE || !streamObj) return;
  const { stream } = streamObj;
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  stream.write(
    [
      esc(row.action),
      esc(row.vendor_sku),
      esc(row.product_sku),
      esc(row.keystone_code),
      esc(row.vendor_cost),
      esc(row.vendor_inventory),
    ].join(",") + "\n"
  );
}

(async function run() {
  console.log("🚀 Seeding Keystone vendor products from local CSVs...");
  const start = performance.now();

  let created = 0;
  let updated = 0;
  let missingProduct = 0;
  let deduped = 0;
  let processed = 0;

  const csvLog = openCsvLog();

  try {
    // 1) read local files
    const fileSets = await parseKeystoneLocal(KEYSTONE_DIR);

    // 2) normalize rows (VCPN = Keystone code)
    const rows = [];
    for (const f of fileSets) {
      for (const r of f.data || []) {
        const VCPN = clean(r.vcPn ?? r.VCPN ?? r.VcPn);
        if (!VCPN) continue;
        rows.push({
          VCPN,
          cost: toFloatOrNull(r.cost),
          totalQty: toInt(r.totalQty),
        });
      }
    }
    console.log(`📦 Total rows parsed: ${rows.length}`);
    if (rows.length === 0) {
      console.log("ℹ️ No rows found. Check CSV headers & path:", KEYSTONE_DIR);
      if (csvLog) csvLog.stream.end();
      await prisma.$disconnect();
      return;
    }

    // 3) batch-load products by keystone_code
    const uniqueCodes = [...new Set(rows.map((x) => x.VCPN))];
    console.log(`🔎 Loading Products by keystone_code for ${uniqueCodes.length} codes...`);

    const products = await prisma.product.findMany({
  where: { keystone_code: { in: uniqueCodes } },
  select: { keystone_code: true, sku: true },
});

// prefer SKUs that don't end with a hyphen
const endsWithDash = (s) => /-\s*$/.test(s);

const productByKeystone = new Map();
let duplicateKeystoneCodes = 0;

for (const p of products) {
  const key = p.keystone_code;
  const candidate = p.sku;
  const current = productByKeystone.get(key);

  if (!current) {
    productByKeystone.set(key, candidate);
    continue;
  }
  duplicateKeystoneCodes++;

  const candBad = endsWithDash(candidate);
  const curBad = endsWithDash(current);

  // If current is "bad" (ends with '-') and candidate is "good", replace.
  if (curBad && !candBad) {
    productByKeystone.set(key, candidate);
  }
  // else: keep the existing selection (first good wins; if both bad, first wins)
}

if (duplicateKeystoneCodes) {
  console.log(`ℹ️ Resolved ${duplicateKeystoneCodes} duplicate keystone_code collisions (prefer non-dash SKUs).`);
}

    // const products = await prisma.product.findMany({
    //   where: { keystone_code: { in: uniqueCodes } },
    //   select: { keystone_code: true, sku: true },
    // });
    // const productByKeystone = new Map(products.map((p) => [p.keystone_code, p.sku]));
    console.log(`✅ Matched ${products.length}/${uniqueCodes.length} product codes`);

    // 4) optional clear
    if (CLEAR_OLD_FIRST) {
      await prisma.vendorProduct.deleteMany({
        where: { vendor: { is: VENDOR_CONNECT } }, // relation filter
      });
      console.log("🗑️ Deleted existing Keystone vendor products");
    }

    // 5) process rows
    for (const r of rows) {
      processed++;
      const { VCPN, cost, totalQty } = r;
      const sku = productByKeystone.get(VCPN);
      if (!sku) {
        if (missingProduct < 25) console.log(`⚠️ Missing product for Keystone code ${VCPN}`);
        missingProduct++;
        continue;
      }

      const vendorSku = VCPN; // API logic: vendor_sku must be VCPN

      if (CLEAR_OLD_FIRST) {
        // Create-only; your schema requires vendor_cost on create => skip if missing
        if (!isNum(cost)) {
          if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
          continue;
        }
        await prisma.vendorProduct.create({
          data: {
            vendor_sku: vendorSku,
            vendor_cost: cost,
            ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
            vendor: { connect: VENDOR_CONNECT },
            product: { connect: { sku } },
          },
        });
        created++;
        writeCsv(csvLog, {
          action: "CREATE",
          vendor_sku: vendorSku,
          product_sku: sku,
          keystone_code: VCPN,
          vendor_cost: cost,
          vendor_inventory: totalQty,
        });
        if (VERBOSE_ROW_LOGS) console.log(`[CREATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
        continue;
      }

      if (UPDATE_OR_CREATE_BY_VENDOR_SKU) {
        // find existing by (vendor relation + vendor_sku)
        const existing = await prisma.vendorProduct.findMany({
          where: { vendor_sku: vendorSku, vendor: { is: VENDOR_CONNECT } },
          orderBy: { id: "desc" },
          select: { id: true },
        });

        if (existing.length > 0) {
          const keep = existing[0];
          const toDeleteIds = existing.slice(1).map((x) => x.id);
          if (toDeleteIds.length) {
            await prisma.vendorProduct.deleteMany({ where: { id: { in: toDeleteIds } } });
            deduped += toDeleteIds.length;
          }

          // UPDATE: omit vendor_cost if not numeric (don’t send null)
          const data = {
            vendor_sku: vendorSku,
            ...(isNum(cost) ? { vendor_cost: cost } : {}),
            ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
            vendor: { connect: VENDOR_CONNECT },
            product: { connect: { sku } },
          };
          await prisma.vendorProduct.update({ where: { id: keep.id }, data });
          updated++;
          writeCsv(csvLog, {
            action: "UPDATE",
            vendor_sku: vendorSku,
            product_sku: sku,
            keystone_code: VCPN,
            vendor_cost: isNum(cost) ? cost : "",
            vendor_inventory: isNum(totalQty) ? totalQty : "",
          });
          if (VERBOSE_ROW_LOGS) console.log(`[UPDATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
        } else {
          // CREATE: vendor_cost required on create => skip if missing
          if (!isNum(cost)) {
            if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
            continue;
          }
          await prisma.vendorProduct.create({
            data: {
              vendor_sku: vendorSku,
              vendor_cost: cost,
              ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
              vendor: { connect: VENDOR_CONNECT },
              product: { connect: { sku } },
            },
          });
          created++;
          writeCsv(csvLog, {
            action: "CREATE",
            vendor_sku: vendorSku,
            product_sku: sku,
            keystone_code: VCPN,
            vendor_cost: cost,
            vendor_inventory: totalQty,
          });
          if (VERBOSE_ROW_LOGS) console.log(`[CREATE] vendor_sku=${vendorSku} product_sku=${sku} cost=${cost} inv=${totalQty}`);
        }
      } else {
        // fallback: find by both relations
        const existing = await prisma.vendorProduct.findFirst({
          where: { vendor: { is: VENDOR_CONNECT }, product: { is: { sku } } },
          select: { id: true },
        });

        if (existing) {
          const data = {
            vendor_sku: vendorSku,
            ...(isNum(cost) ? { vendor_cost: cost } : {}),
            ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
            vendor: { connect: VENDOR_CONNECT },
            product: { connect: { sku } },
          };
          await prisma.vendorProduct.update({ where: { id: existing.id }, data });
          updated++;
          writeCsv(csvLog, {
            action: "UPDATE",
            vendor_sku: vendorSku,
            product_sku: sku,
            keystone_code: VCPN,
            vendor_cost: isNum(cost) ? cost : "",
            vendor_inventory: isNum(totalQty) ? totalQty : "",
          });
        } else {
          if (!isNum(cost)) {
            if (VERBOSE_ROW_LOGS) console.log(`[SKIP] ${vendorSku} (no cost; vendor_cost required on create)`);
            continue;
          }
          await prisma.vendorProduct.create({
            data: {
              vendor_sku: vendorSku,
              vendor_cost: cost,
              ...(isNum(totalQty) ? { vendor_inventory: totalQty } : {}),
              vendor: { connect: VENDOR_CONNECT },
              product: { connect: { sku } },
            },
          });
          created++;
          writeCsv(csvLog, {
            action: "CREATE",
            vendor_sku: vendorSku,
            product_sku: sku,
            keystone_code: VCPN,
            vendor_cost: cost,
            vendor_inventory: totalQty,
          });
        }
      }

      if (processed % PROGRESS_EVERY === 0) {
        console.log(`⏳ ${processed} processed · ${created} created · ${updated} updated · ${missingProduct} missing · ${deduped} deduped`);
      }
    }

    const secs = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`
✅ Keystone (LOCAL CSV) seeding done!
📊 Created: ${created}
📊 Updated: ${updated}
🧩 Missing product matches: ${missingProduct}
🧹 De-duped removed: ${deduped}
⏱️ Time: ${secs}s
    `);

    if (csvLog) {
      console.log(`📝 Detailed CSV log: ${csvLog.filePath}`);
      csvLog.stream.end();
    }
  } catch (e) {
    console.error("❌ Seed failed:", e);
    if (csvLog) csvLog.stream.end();
  } finally {
    await prisma.$disconnect();
  }
})();
