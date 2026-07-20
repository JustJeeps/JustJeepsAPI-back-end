

/* eslint-disable no-console */
const { PrismaClient } = require("@prisma/client");
const path = require("path");
const fs = require("fs");
const csv = require("csv-parser");
const { performance } = require("perf_hooks");

// Brand config + aliases
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const prisma = new PrismaClient();

/** =========================
 *        CONFIG
 * ========================== */
const KEYSTONE_DIR = path.resolve(__dirname, "keystone_files");
const KEYSTONE_FILES = ["Inventory.csv", "SpecialOrder.csv"];
const WRITE_LOGS = process.env.WRITE_LOGS !== "false";
const DRY_RUN = process.env.DRY_RUN === "true";
const BATCH_SIZE = 100;
const MAX_WRITE_RETRIES = 5;

// Optional per-brand split report (example: Mickey)
const REPORT_CANON_BRANDS = [
  "MICKEY THOMPSON Tires/Wheels",
];

/** =========================
 *       UTIL HELPERS
 * ========================== */
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalize for join keys (strip ="...", uppercase, remove non [A-Z0-9]) */
function normalize(str) {
  if (str == null) return "";
  const cleaned = String(str).replace(/^=\s*"?/, "").replace(/"$/, "");
  return cleaned.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Normalize a code the way the DB expects it */
function normalizeVcPnForDB(code) {
  if (code == null) return "";
  return String(code).trim().replace(/\s+/g, "").toUpperCase();
}

/** Clean Excel-ish strings like ="800110" */
function clean(s) {
  if (s == null) return "";
  let t = String(s).trim();
  if (/^=\s*".*"$/.test(t)) t = t.replace(/^=\s*"(.*)"$/, "$1"); // ="123" -> 123
  return t.replace(/^"+|"+$/g, "").trim();
}

/** Prefer product whose SKU does NOT end with '-' (tie-break: shorter SKU) */
function pickPreferredProduct(a, b) {
  const aBad = a.sku.endsWith("-");
  const bBad = b.sku.endsWith("-");
  if (aBad !== bBad) return aBad ? b : a;
  return a.sku.length <= b.sku.length ? a : b;
}

const equal = (a, b) => (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();

function isRetryableWriteError(error) {
  const message = String(error?.message || error || "");
  return /deadlock detected|E40P01|could not serialize access|40001|P2034/i.test(message);
}

async function withWriteRetry(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteError(error) || attempt === MAX_WRITE_RETRIES) {
        throw error;
      }
      const waitMs = 500 * attempt * attempt;
      console.warn(`⚠️ ${label} hit a retryable DB write conflict (attempt ${attempt}/${MAX_WRITE_RETRIES}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/** =========================
 *   ALIAS & SITE PREFIX MAPS
 * ========================== */
/** Build alias -> canonical brand map from vendors_prefix */
function buildAliasToCanonicalMap() {
  const map = new Map();
  for (const v of vendorsPrefix) {
    const canonical = v.keystone_ftp_brand_canonical || v.keystone_ftp_brand || v.brand_name;
    if (!canonical) continue;
    const aliases = new Set([
      canonical,
      v.keystone_ftp_brand,
      ...(Array.isArray(v.keystone_ftp_brand_aliases) ? v.keystone_ftp_brand_aliases : []),
    ].filter(Boolean));
    for (const alias of aliases) {
      map.set(normalize(alias), canonical);
    }
  }
  return map;
}

/** Build alias -> site prefix map (per-alias overrides, then default keystone_code_site) */
function buildAliasToSitePrefixMap() {
  const map = new Map();
  for (const v of vendorsPrefix) {
    const canonical = v.keystone_ftp_brand_canonical || v.keystone_ftp_brand || v.brand_name;
    if (!canonical) continue;

    // First, apply explicit per-alias site prefixes (highest priority)
    if (v.keystone_code_site_aliases) {
      for (const [alias, sitePrefix] of Object.entries(v.keystone_code_site_aliases)) {
        if (!sitePrefix) continue;
        map.set(normalize(alias), String(sitePrefix));
      }
    }

    // Then, fall back so that all aliases (including canonical) inherit a single default site prefix if provided
    if (v.keystone_code_site) {
      const aliases = new Set([
        canonical,
        v.keystone_ftp_brand,
        ...(Array.isArray(v.keystone_ftp_brand_aliases) ? v.keystone_ftp_brand_aliases : []),
      ].filter(Boolean));
      for (const alias of aliases) {
        const key = normalize(alias);
        if (!map.has(key)) map.set(key, String(v.keystone_code_site));
      }
    }
  }
  return map;
}

function canonicalizeBrand(brandRaw, aliasToCanonical) {
  return aliasToCanonical.get(normalize(brandRaw)) || brandRaw || "";
}

/** =========================
 *   LOAD PRODUCTS -> INDEX
 * ========================== */
async function loadProductIndex(aliasToCanonical) {
  const build = (products, searchableField) => {
    const index = new Map();
    for (const p of products) {
      const canonBrand = canonicalizeBrand(p.keystone_ftp_brand || p.brand_name, aliasToCanonical);
      const searchVal = p[searchableField];
      const key = normalize(canonBrand) + normalize(searchVal);
      const existing = index.get(key);
      if (!existing) index.set(key, p);
      else index.set(key, pickPreferredProduct(existing, p));
    }
    console.log(`🧩 Product keys: ${index.size.toLocaleString()} (from ${products.length.toLocaleString()} products)`);
    return index;
  };

  // Try camelCase searchableSku first; fallback to snake_case
  try {
    const products = await prisma.product.findMany({
      where: {
        searchableSku: { not: null },
        OR: [{ keystone_ftp_brand: { not: null } }, { brand_name: { not: null } }],
      },
      select: {
        sku: true,
        searchableSku: true,
        brand_name: true,
        keystone_ftp_brand: true,
        keystone_code: true,
        keystone_code_site: true,
      },
    });
    return build(products, "searchableSku");
  } catch (err) {
    const products = await prisma.product.findMany({
      where: {
        searchable_sku: { not: null },
        OR: [{ keystone_ftp_brand: { not: null } }, { brand_name: { not: null } }],
      },
      select: {
        sku: true,
        searchable_sku: true,
        brand_name: true,
        keystone_ftp_brand: true,
        keystone_code: true,
        keystone_code_site: true,
      },
    });
    return build(products, "searchable_sku");
  }
}

/** =========================
 *   STREAM FTP CSV FILES
 * ==========================
 * The FTP side is ~2.5M rows (SpecialOrder.csv alone is ~460MB), while the
 * product index is only a few thousand entries. Never materialize the FTP
 * rows: stream each CSV and probe the small product index per row. Memory
 * stays proportional to the product index + matches, not to the CSV size.
 */
function streamKeystoneFile(absPath, onRow) {
  return new Promise((resolve) => {
    if (!fs.existsSync(absPath)) {
      console.warn(`⚠️ File not found: ${absPath} — skipping`);
      return resolve(null);
    }

    const stats = {
      file: path.basename(absPath),
      rows: 0,
      haveVCPN: 0,
      builtFromVendorPart: 0,
      emptyVCPN: 0,
    };

    fs.createReadStream(absPath)
      .pipe(csv())
      .on("data", (raw) => {
        const get = (...keys) => {
          for (const k of keys) {
            if (raw[k] !== undefined) return String(raw[k]).trim();
          }
          return "";
        };

        const vendorCode = clean(get("VendorCode", "Vendor Code", "Vendor", "VENDOR"));
        const vendorName = clean(
          get("VendorName", "Vendor Name", "Brand", "Manufacturer")
        );
        const manufacturerPartNo = clean(
          get(
            "ManufacturerPartNo",
            "Manufacturer Part No",
            "Manufacturer Part Number",
            "ManufacturerPartNumber",
            "MfrPartNo",
            "Mfr Part #",
            "MPN"
          )
        );

        // PartNumber is the vendor's part number (not the MPN); only used to derive VCPN
        const partNumber = clean(
          get("PartNumber", "Part Number", "PARTNUMBER", "PartNo", "Part #", "PN")
        );

        // Keystone code (VCPN) may be present or derivable
        let vcPn = clean(get("vcPn", "VCPN", "VcPn", "KeystonePN", "KeystoneCode", "Keystone_Code"));

        if (!vcPn) {
          if (vendorCode && partNumber) {
            vcPn = normalizeVcPnForDB(`${vendorCode}${partNumber}`);
            if (vcPn) stats.builtFromVendorPart++;
            else stats.emptyVCPN++;
          } else {
            stats.emptyVCPN++;
          }
        } else {
          vcPn = normalizeVcPnForDB(vcPn);
          stats.haveVCPN++;
        }

        if (!vcPn) return; // no join key — skip line

        stats.rows++;
        onRow({ vcPn, vendorName, manufacturerPartNo });
      })
      .on("end", () => resolve(stats))
      .on("error", (err) => {
        console.error(`❌ Stream error on ${stats.file}:`, err.message);
        resolve(stats);
      });
  });
}

/** =========================
 *      APPLY UPDATES
 * ========================== */
async function main() {
  console.log("🚀 Fixing product.keystone_code (+ keystone_code_site) from Keystone FTP with brand + site aliases...");
  const start = performance.now();

  // 0) Build alias maps
  const aliasToCanonical = buildAliasToCanonicalMap();
  const aliasToSitePrefix = buildAliasToSitePrefixMap();

  // 1) Small side of the join first: product index (~few thousand entries)
  const productIndex = await loadProductIndex(aliasToCanonical);

  const reportCanonSet = new Set(REPORT_CANON_BRANDS.map((b) => canonicalizeBrand(b, aliasToCanonical)));

  // 2) Stream FTP files, probing the product index per row.
  // First occurrence of a key wins (same as the old pre-built FTP map).
  // Only matched keys are remembered — no-match keys would be millions.
  const seenMatchedKeys = new Set();
  const updateBySku = new Map();
  const splitBuckets = new Map(); // brand -> rows for report
  let totalRows = 0;
  let aliasHits = 0;
  let matched = 0;
  let missing = 0; // counts row-key probes without a product (not unique keys)
  let alreadyCorrect = 0;

  const handleRow = ({ vcPn, vendorName, manufacturerPartNo }) => {
    totalRows++;
    const vendorNameRaw = vendorName;
    const vendorNameCanon = canonicalizeBrand(vendorNameRaw, aliasToCanonical);
    if (vendorNameCanon !== vendorNameRaw) aliasHits++;

    const vcPnClean = String(vcPn).trim();

    // Same key order as before: ManufacturerPartNo first, then VCPN
    for (const keyPart of [manufacturerPartNo, vcPnClean]) {
      const key = normalize(vendorNameCanon) + normalize(keyPart);
      if (!key || seenMatchedKeys.has(key)) continue;

      const prod = productIndex.get(key);
      if (!prod) { missing++; continue; }

      seenMatchedKeys.add(key);
      matched++;

      // Split report (e.g., Mickey)
      if (reportCanonSet.has(vendorNameCanon)) {
        if (!splitBuckets.has(vendorNameCanon)) splitBuckets.set(vendorNameCanon, []);
        splitBuckets.get(vendorNameCanon).push({
          product_sku: prod.sku,
          ftp_vendor_name: vendorNameRaw,
          manufacturer_part_no: manufacturerPartNo,
          vcPn: vcPnClean,
        });
      }

      // Decide new values
      const change = {};

      // keystone_code from VCPN (only if different)
      if (!equal(prod.keystone_code, vcPnClean)) {
        change.keystone_code = vcPnClean;
      }

      // keystone_code_site from alias-specific site prefix + product searchableSku/_sku
      const searchVal = prod.searchableSku ?? prod.searchable_sku ?? "";
      const sitePrefix =
        aliasToSitePrefix.get(normalize(vendorNameRaw)) ||
        aliasToSitePrefix.get(normalize(vendorNameCanon)) ||
        null;

      if (sitePrefix && searchVal) {
        const desiredSitePid = `${sitePrefix}${searchVal}`;
        if (!equal(prod.keystone_code_site, desiredSitePid)) {
          change.keystone_code_site = desiredSitePid;
        }
      }

      if (Object.keys(change).length === 0) {
        alreadyCorrect++;
        continue;
      }

      if (!updateBySku.has(prod.sku)) {
        updateBySku.set(prod.sku, {
          sku: prod.sku,
          old_code: prod.keystone_code || "",
          new_code: change.keystone_code ?? "",
          old_site: prod.keystone_code_site || "",
          new_site: change.keystone_code_site ?? "",
          brand: vendorNameCanon,
          ftp_vendor_name: vendorNameRaw,
          mpn: manufacturerPartNo,
        });
      }
    }
  };

  const fileStats = [];
  for (const file of KEYSTONE_FILES) {
    const stats = await streamKeystoneFile(path.resolve(KEYSTONE_DIR, file), handleRow);
    if (stats) fileStats.push(stats);
  }
  console.log("🧪 VCPN extraction summary per file:", fileStats);
  console.log(`📦 Streamed FTP rows: ${totalRows.toLocaleString()} (aliases used: ${aliasHits.toLocaleString()})`);
  console.log(`🔎 Matched keys: ${matched.toLocaleString()} | No-match probes: ${missing.toLocaleString()}`);
  console.log(`✅ Already correct (no update needed): ${alreadyCorrect.toLocaleString()}`);

  const updates = [...updateBySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  console.log(`✏️  Will update ${updates.length.toLocaleString()} products`);

  // 3) CSV audit
  let outPath = "";
  if (WRITE_LOGS) {
    const outDir = path.resolve(__dirname, "../logs");
    ensureDir(outDir);
    outPath = path.join(outDir, `keystone-code-fix-${ts()}.csv`);
    const header = [
      "product_sku",
      "old_keystone_code",
      "new_keystone_code",
      "old_keystone_code_site",
      "new_keystone_code_site",
      "CanonicalBrand",
      "FTPVendorName",
      "ManufacturerPartNo",
    ].join(",");
    const lines = updates.map((u) =>
      [
        u.sku,
        u.old_code,
        u.new_code,
        u.old_site,
        u.new_site,
        `"${(u.brand || "").replace(/"/g, '""')}"`,
        `"${(u.ftp_vendor_name || "").replace(/"/g, '""')}"`,
        `"${(u.mpn || "").replace(/"/g, '""')}"`,
      ].join(",")
    );
    fs.writeFileSync(outPath, `${header}\n${lines.join("\n")}`, "utf8");
    console.log(`📝 CSV log written: ${outPath}`);
  }

  // 4) Optional: per-brand split report
  if (splitBuckets.size) {
    const outDir = path.resolve(__dirname, "../logs");
    ensureDir(outDir);
    for (const [canonBrand, rows] of splitBuckets) {
      const fileSafe = canonBrand.replace(/[^A-Za-z0-9]+/g, "-");
      const splitPath = path.join(outDir, `${fileSafe}-ftp-subbrand-split-${ts()}.csv`);
      const header = ["product_sku","ftp_vendor_name","manufacturer_part_no","vcPn"].join(",");
      const lines = rows
        .sort((a,b) => a.ftp_vendor_name.localeCompare(b.ftp_vendor_name) || a.product_sku.localeCompare(b.product_sku))
        .map(r =>
          [
            r.product_sku,
            `"${(r.ftp_vendor_name || "").replace(/"/g, '""')}"`,
            `"${(r.manufacturer_part_no || "").replace(/"/g, '""')}"`,
            r.vcPn
          ].join(",")
        );
      fs.writeFileSync(splitPath, `${header}\n${lines.join("\n")}`, "utf8");
      console.log(`📝 Split report for "${canonBrand}": ${splitPath}`);
    }
  }

  // 5) Apply updates (unless DRY_RUN)
  if (DRY_RUN) {
    console.log("🧪 DRY_RUN enabled — no database writes performed.");
  } else {
    let applied = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const slice = updates.slice(i, i + BATCH_SIZE);
      await withWriteRetry(
        () => prisma.$transaction(
          slice.map((u) => {
            const data = {};
            if (u.new_code) data.keystone_code = u.new_code;
            if (u.new_site) data.keystone_code_site = u.new_site;
            return prisma.product.update({
              where: { sku: u.sku },
              data,
            });
          })
        ),
        `product update batch ${Math.floor(i / BATCH_SIZE) + 1}`
      );
      applied += slice.length;
      console.log(`   → Applied ${applied.toLocaleString()}/${updates.length.toLocaleString()}`);
    }
  }

  console.log(`✅ Done in ${((performance.now() - start) / 1000).toFixed(2)}s`);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error("❌ Failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
}

module.exports = main;
