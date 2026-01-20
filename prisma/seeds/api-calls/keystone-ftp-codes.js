

/* eslint-disable no-console */
const { PrismaClient } = require("@prisma/client");
const path = require("path");
const fs = require("fs");
const { performance } = require("perf_hooks");

// Parser returns: { vcPn, vendorName, manufacturerPartNo, ... }
const parseKeystoneLocal = require("./parse-keystone-local");
// Brand config + aliases
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const prisma = new PrismaClient();

/** =========================
 *        CONFIG
 * ========================== */
const KEYSTONE_DIR = path.resolve(__dirname, "keystone_files");
const WRITE_LOGS = true;
const DRY_RUN = false;
const BATCH_SIZE = 500;

// Optional per-brand split report (example: Mickey)
const REPORT_CANON_BRANDS = [
  "MICKEY THOMPSON Tires/Wheels",
];

/** =========================
 *       UTIL HELPERS
 * ========================== */
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

/** Normalize for join keys (strip ="...", uppercase, remove non [A-Z0-9]) */
function normalize(str) {
  if (str == null) return "";
  const cleaned = String(str).replace(/^=\s*"?/, "").replace(/"$/, "");
  return cleaned.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Prefer product whose SKU does NOT end with '-' (tie-break: shorter SKU) */
function pickPreferredProduct(a, b) {
  const aBad = a.sku.endsWith("-");
  const bBad = b.sku.endsWith("-");
  if (aBad !== bBad) return aBad ? b : a;
  return a.sku.length <= b.sku.length ? a : b;
}

const equal = (a, b) => (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();

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
 *      LOAD FTP -> MAP
 * ========================== */
async function loadFtpMap(aliasToCanonical) {
  const files = await parseKeystoneLocal(KEYSTONE_DIR);
  const rows = files.flatMap((f) => f.data || []);
  console.log(`📦 Parsed FTP rows: ${rows.length.toLocaleString()}`);

  // Map< key, { vcPn, vendorNameRaw, vendorNameCanon, manufacturerPartNo } >
  const map = new Map();
  let aliasHits = 0;

  for (const r of rows) {
    const vendorNameRaw = r.vendorName ?? r.VendorName ?? "";
    const vendorNameCanon = canonicalizeBrand(vendorNameRaw, aliasToCanonical);
    if (vendorNameCanon !== vendorNameRaw) aliasHits++;

    const manufacturerPartNo = r.manufacturerPartNo ?? r.ManufacturerPartNo ?? "";
    const vcPn = r.vcPn ?? r.VCPN;
    if (!vcPn) continue;

    const key = normalize(vendorNameCanon) + normalize(manufacturerPartNo);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        vcPn: String(vcPn).trim(),
        vendorNameRaw,
        vendorNameCanon,
        manufacturerPartNo,
      });
    }
  }
  console.log(`🗺️  FTP keys (post-alias): ${map.size.toLocaleString()} (aliases used: ${aliasHits.toLocaleString()})`);
  return map;
}

/** =========================
 *   LOAD PRODUCTS -> INDEX
 * ========================== */
async function loadProductIndex(aliasToCanonical) {
  const build = (products, searchableField) => {
    const index = new Map();
    for (const p of products) {
      const canonBrand = canonicalizeBrand(p.keystone_ftp_brand, aliasToCanonical);
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
      where: { keystone_ftp_brand: { not: null }, searchableSku: { not: null } },
      select: {
        sku: true,
        searchableSku: true,
        keystone_ftp_brand: true,
        keystone_code: true,
        keystone_code_site: true,
      },
    });
    return build(products, "searchableSku");
  } catch (err) {
    const products = await prisma.product.findMany({
      where: { keystone_ftp_brand: { not: null }, searchable_sku: { not: null } },
      select: {
        sku: true,
        searchable_sku: true,
        keystone_ftp_brand: true,
        keystone_code: true,
        keystone_code_site: true,
      },
    });
    return build(products, "searchable_sku");
  }
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

  // 1) Build maps
  const ftpMap = await loadFtpMap(aliasToCanonical);
  const productIndex = await loadProductIndex(aliasToCanonical);

  // 2) Compute planned updates + optional per-brand split report
  const updates = []; // items with { sku, old_code, new_code?, old_site, new_site? , brand, ftp_vendor_name, mpn }
  const splitBuckets = new Map(); // brand -> rows for report
  let matched = 0;
  let missing = 0;
  let alreadyCorrect = 0;

  const reportCanonSet = new Set(REPORT_CANON_BRANDS.map((b) => canonicalizeBrand(b, aliasToCanonical)));

  for (const [key, data] of ftpMap.entries()) {
    const prod = productIndex.get(key);
    if (!prod) { missing++; continue; }
    matched++;

    // Split report (e.g., Mickey)
    if (reportCanonSet.has(data.vendorNameCanon)) {
      if (!splitBuckets.has(data.vendorNameCanon)) splitBuckets.set(data.vendorNameCanon, []);
      splitBuckets.get(data.vendorNameCanon).push({
        product_sku: prod.sku,
        ftp_vendor_name: data.vendorNameRaw,
        manufacturer_part_no: data.manufacturerPartNo,
        vcPn: data.vcPn,
      });
    }

    // Decide new values
    const change = {};

    // keystone_code from VCPN (only if different)
    if (!equal(prod.keystone_code, data.vcPn)) {
      change.keystone_code = data.vcPn;
    }

    // keystone_code_site from alias-specific site prefix + product searchableSku/_sku
    const searchVal = prod.searchableSku ?? prod.searchable_sku ?? "";
    const sitePrefix =
      aliasToSitePrefix.get(normalize(data.vendorNameRaw)) ||
      aliasToSitePrefix.get(normalize(data.vendorNameCanon)) ||
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

    updates.push({
      sku: prod.sku,
      old_code: prod.keystone_code || "",
      new_code: change.keystone_code ?? "",
      old_site: prod.keystone_code_site || "",
      new_site: change.keystone_code_site ?? "",
      brand: data.vendorNameCanon,
      ftp_vendor_name: data.vendorNameRaw,
      mpn: data.manufacturerPartNo,
    });
  }

  console.log(`🔎 Matches: ${matched.toLocaleString()} | No-match: ${missing.toLocaleString()}`);
  console.log(`✅ Already correct (no update needed): ${alreadyCorrect.toLocaleString()}`);
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
      await prisma.$transaction(
        slice.map((u) => {
          const data = {};
          if (u.new_code) data.keystone_code = u.new_code;
          if (u.new_site) data.keystone_code_site = u.new_site;
          return prisma.product.update({
            where: { sku: u.sku },
            data,
          });
        })
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


// /* eslint-disable no-console */
// const { PrismaClient } = require("@prisma/client");
// const path = require("path");
// const fs = require("fs");
// const { performance } = require("perf_hooks");

// // Parser returns: { vcPn, vendorName, manufacturerPartNo, ... }
// const parseKeystoneLocal = require("./parse-keystone-local");

// const prisma = new PrismaClient();

// /** =========================
//  *        CONFIG
//  * ========================== */
// const KEYSTONE_DIR = path.resolve(__dirname, "keystone_files");
// const WRITE_LOGS = true;
// const DRY_RUN = false;
// const BATCH_SIZE = 500;

// /** =========================
//  *       UTIL HELPERS
//  * ========================== */
// const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
// function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// /** Normalize join keys:
//  * - strip ="..."; uppercase; remove non [A-Z0-9]
//  */
// function normalize(str) {
//   if (str == null) return "";
//   const cleaned = String(str).replace(/^=\s*"?/, "").replace(/"$/, "");
//   return cleaned.toUpperCase().replace(/[^A-Z0-9]/g, "");
// }

// /** Prefer product whose SKU does NOT end with '-' */
// function pickPreferredProduct(a, b) {
//   const aBad = a.sku.endsWith("-");
//   const bBad = b.sku.endsWith("-");
//   if (aBad !== bBad) return aBad ? b : a;
//   // tie-breaker: shorter SKU first; else keep existing (a)
//   return a.sku.length <= b.sku.length ? a : b;
// }

// /** =========================
//  *      LOAD FTP -> MAP
//  * ========================== */
// async function loadFtpMap() {
//   const files = await parseKeystoneLocal(KEYSTONE_DIR);
//   const rows = files.flatMap((f) => f.data || []);
//   console.log(`📦 Parsed FTP rows: ${rows.length.toLocaleString()}`);

//   // Map< key, { vcPn, vendorName, manufacturerPartNo } >
//   const map = new Map();

//   for (const r of rows) {
//     const vendorName = r.vendorName ?? r.VendorName ?? "";
//     const manufacturerPartNo = r.manufacturerPartNo ?? r.ManufacturerPartNo ?? "";
//     const vcPn = r.vcPn ?? r.VCPN;

//     const key = normalize(vendorName) + normalize(manufacturerPartNo);
//     if (!key || !vcPn) continue;

//     // keep first; good enough for this correction pass
//     if (!map.has(key)) {
//       map.set(key, {
//         vcPn: String(vcPn).trim(),
//         vendorName,
//         manufacturerPartNo,
//       });
//     }
//   }
//   console.log(`🗺️  FTP keys: ${map.size.toLocaleString()}`);
//   return map;
// }

// /** =========================
//  *   LOAD PRODUCTS -> INDEX
//  * ========================== */
// async function loadProductIndex() {
//   // try with searchableSku (camelCase) first; if prisma errors, retry with searchable_sku
//   const build = (products, searchableField) => {
//     const index = new Map();
//     for (const p of products) {
//       const searchVal = p[searchableField];
//       const key = normalize(p.keystone_ftp_brand) + normalize(searchVal);
//       const existing = index.get(key);
//       if (!existing) index.set(key, p);
//       else index.set(key, pickPreferredProduct(existing, p));
//     }
//     console.log(`🧩 Product keys: ${index.size.toLocaleString()} (from ${products.length.toLocaleString()} products)`);
//     return index;
//   };

//   try {
//     const products = await prisma.product.findMany({
//       where: { keystone_ftp_brand: { not: null }, searchableSku: { not: null } },
//       select: { sku: true, searchableSku: true, keystone_ftp_brand: true, keystone_code: true },
//     });
//     return build(products, "searchableSku");
//   } catch (err) {
//     // fallback to snake_case
//     if (!/searchableSku/i.test(String(err))) throw err;
//     const products = await prisma.product.findMany({
//       where: { keystone_ftp_brand: { not: null }, searchable_sku: { not: null } },
//       select: { sku: true, searchable_sku: true, keystone_ftp_brand: true, keystone_code: true },
//     });
//     return build(products, "searchable_sku");
//   }
// }

// /** =========================
//  *      APPLY UPDATES
//  * ========================== */
// async function main() {
//   console.log("🚀 Fixing product.keystone_code from Keystone FTP (VendorName+ManufacturerPartNo → VCPN) ...");
//   const start = performance.now();

//   // 1) Build maps
//   const ftpMap = await loadFtpMap();
//   const productIndex = await loadProductIndex();

//   // 2) Compute planned updates
//   const updates = [];
//   let matched = 0;
//   let missing = 0;

//   for (const [key, data] of ftpMap.entries()) {
//     const prod = productIndex.get(key);
//     if (!prod) { missing++; continue; }
//     matched++;

//     if (prod.keystone_code !== data.vcPn) {
//       updates.push({
//         sku: prod.sku,                // use SKU as unique id
//         from: prod.keystone_code || "",
//         to: data.vcPn,
//         vendorName: data.vendorName,
//         manufacturerPartNo: data.manufacturerPartNo,
//       });
//     }
//   }

//   console.log(`🔎 Matches: ${matched.toLocaleString()} | No-match: ${missing.toLocaleString()}`);
//   console.log(`✏️  Will update keystone_code on ${updates.length.toLocaleString()} products`);

//   // 3) Write CSV audit
//   let outPath = "";
//   if (WRITE_LOGS) {
//     const outDir = path.resolve(__dirname, "../logs");
//     ensureDir(outDir);
//     outPath = path.join(outDir, `keystone-code-fix-${ts()}.csv`);
//     const header = [
//       "product_sku",
//       "old_keystone_code",
//       "new_keystone_code",
//       "VendorName",
//       "ManufacturerPartNo",
//     ].join(",");
//     const lines = updates.map(
//       (u) =>
//         [
//           u.sku,
//           u.from,
//           u.to,
//           `"${(u.vendorName || "").replace(/"/g, '""')}"`,
//           `"${(u.manufacturerPartNo || "").replace(/"/g, '""')}"`,
//         ].join(",")
//     );
//     fs.writeFileSync(outPath, `${header}\n${lines.join("\n")}`, "utf8");
//     console.log(`📝 CSV log written: ${outPath}`);
//   }

//   // 4) Apply updates
//   if (DRY_RUN) {
//     console.log("🧪 DRY_RUN enabled — no database writes performed.");
//   } else {
//     let applied = 0;
//     for (let i = 0; i < updates.length; i += BATCH_SIZE) {
//       const slice = updates.slice(i, i + BATCH_SIZE);
//       await prisma.$transaction(
//         slice.map((u) =>
//           prisma.product.update({
//             where: { sku: u.sku },            // SKU is unique in your schema
//             data: { keystone_code: u.to },
//           })
//         )
//       );
//       applied += slice.length;
//       console.log(`   → Applied ${applied.toLocaleString()}/${updates.length.toLocaleString()}`);
//     }
//   }

//   console.log(`✅ Done in ${((performance.now() - start) / 1000).toFixed(2)}s`);
//   await prisma.$disconnect();
// }

// if (require.main === module) {
//   main().catch(async (e) => {
//     console.error("❌ Failed:", e);
//     await prisma.$disconnect();
//     process.exit(1);
//   });
// }

// module.exports = main;
