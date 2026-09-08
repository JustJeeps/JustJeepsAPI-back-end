/* eslint-disable no-console */

const prisma = require("../../../lib/prisma");
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const BATCH_SIZE = Number(process.env.SEED_VENDOR_PREFIX_BATCH_SIZE || 5000);

const toStringOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
};

const normalizeOmixCode = (value) => {
  const str = toStringOrNull(value);
  if (!str) return null;

  return str.replace(/\.(\d+)$/, (_, decimals) => `.${decimals.padEnd(2, "0")}`);
};

const normalizeKeystoneSearchableSku = (jjPrefix, searchableSku) => {
  if (!searchableSku) return searchableSku;

  // Keystone uses RGA + EV... for Revolution Gear SKUs that begin with REV...
  if (jjPrefix === "RGA" && /^REV/i.test(searchableSku)) {
    return searchableSku.slice(1);
  }

  return searchableSku;
};

const buildPrefixDerivedFields = (sku) => {
  const skuText = String(sku);
  const jjPrefix = skuText.includes("-") ? skuText.split("-")[0] : skuText;
  const searchableSku = skuText.includes("-") ? skuText.slice(skuText.indexOf("-") + 1) : skuText;

  const vendorData = vendorsPrefix.find((vendor) => vendor.jj_prefix === jjPrefix);

  let meyerCode =
    vendorData && vendorData.meyer_code
      ? (vendorData.meyer_code + searchableSku).toUpperCase()
      : "";

  if (jjPrefix === "BST") {
    if (searchableSku === "5240711") {
      meyerCode = (vendorData?.meyer_code || "") + searchableSku;
    } else {
      meyerCode =
        (vendorData?.meyer_code || "") + searchableSku.slice(0, 5) + "-" + searchableSku.slice(5);
    }
  }

  if (jjPrefix === "YUK") {
    meyerCode = ((vendorData?.meyer_code || "") + searchableSku).replace(/\s+/g, "").toUpperCase();
  }

  const keystoneSearchableSku = normalizeKeystoneSearchableSku(jjPrefix, searchableSku);
  const normalizedKeystoneSku = keystoneSearchableSku.replace(/[-./_]/g, "");

  let keystoneCode =
    vendorData && vendorData.keystone_code
      ? jjPrefix === "MKT"
        ? vendorData.keystone_code + searchableSku.slice(-6)
        : vendorData.keystone_code + normalizedKeystoneSku
      : "";

  if (jjPrefix === "CGG") {
    keystoneCode = "CG" + searchableSku.replace(/-/g, "");
  }

  const quadratecCode =
    vendorData && vendorData.quadratec_code ? vendorData.quadratec_code + searchableSku : "";
  const tdotCode = vendorData && vendorData.tdot_code ? vendorData.tdot_code + " " + searchableSku : "";
  const ctpCode = vendorData && vendorData.ctp_code ? vendorData.ctp_code + searchableSku : "";

  let cleanedSearchableSku = searchableSku.replace(/[./_\s]/g, "-");
  if (jjPrefix === "BST") {
    cleanedSearchableSku = cleanedSearchableSku.replace(/(\d+)(\d{2})$/, "$1-$2");
  }

  const partsEngineCode =
    vendorData && vendorData.partsEngine_code
      ? `https://www.partsengine.ca/${cleanedSearchableSku}${vendorData.partsEngine_code}`
      : "";

  const tdotUrl =
    tdotCode && tdotCode.trim() !== ""
      ? `https://www.tdotperformance.ca/catalogsearch/result/?q=${searchableSku}`
      : null;

  let keystoneCodeSite =
    vendorData && vendorData.keystone_code_site ? vendorData.keystone_code_site + keystoneSearchableSku : "";

  if (jjPrefix === "YUK") {
    keystoneCodeSite = keystoneCode || "";
  }

  const keystoneFtpBrand =
    vendorData && (vendorData.keystone_ftp_brand || vendorData.keystone_ftp_brand_canonical)
      ? vendorData.keystone_ftp_brand || vendorData.keystone_ftp_brand_canonical
      : null;

  const t14Code = vendorData && vendorData.t14_code ? vendorData.t14_code + searchableSku : "";
  const premierCode = vendorData && vendorData.premier_code ? vendorData.premier_code + searchableSku : "";
  const brandName = vendorData ? vendorData.brand_name : "";
  const vendors = vendorData ? vendorData.vendors : "";

  const keystoneBrandCode = toStringOrNull(vendorData?.brand_name) || "";
  const keystoneQbCode = keystoneBrandCode ? `${keystoneBrandCode}${normalizedKeystoneSku}` : "";

  return {
    sku: skuText,
    jj_prefix: toStringOrNull(jjPrefix),
    meyer_code: toStringOrNull(meyerCode),
    keystone_code: toStringOrNull(keystoneCode),
    keystone_brand_code: toStringOrNull(keystoneBrandCode),
    keystone_qb_code: toStringOrNull(keystoneQbCode),
    quadratec_code: toStringOrNull(quadratecCode),
    tdot_code: toStringOrNull(tdotCode),
    t14_code: toStringOrNull(t14Code),
    premier_code: toStringOrNull(premierCode),
    partsEngine_code: toStringOrNull(partsEngineCode),
    tdot_url: toStringOrNull(tdotUrl),
    keystone_code_site: toStringOrNull(keystoneCodeSite),
    keystone_ftp_brand: toStringOrNull(keystoneFtpBrand),
    ctp_code: toStringOrNull(ctpCode),
    omix_code:
      jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR" || jjPrefix === "HVC"
        ? normalizeOmixCode(searchableSku)
        : null,
    brand_name: toStringOrNull(brandName),
    vendors: toStringOrNull(vendors),
  };
};

const bulkUpdateProducts = async (rowsToUpdate) => {
  if (!rowsToUpdate.length) return;

  const json = JSON.stringify(rowsToUpdate);

  await prisma.$executeRaw`
    WITH data AS (
      SELECT *
      FROM json_to_recordset(${json}::json) AS x(
        sku text,
        jj_prefix text,
        meyer_code text,
        keystone_code text,
        keystone_brand_code text,
        keystone_qb_code text,
        quadratec_code text,
        tdot_code text,
        t14_code text,
        premier_code text,
        "partsEngine_code" text,
        tdot_url text,
        "keystone_code_site" text,
        "keystone_ftp_brand" text,
        ctp_code text,
        omix_code text,
        brand_name text,
        vendors text
      )
    )
    UPDATE "Product" p
    SET
      jj_prefix = data.jj_prefix,
      meyer_code = data.meyer_code,
      keystone_code = data.keystone_code,
      keystone_brand_code = data.keystone_brand_code,
      keystone_qb_code = data.keystone_qb_code,
      quadratec_code = data.quadratec_code,
      tdot_code = data.tdot_code,
      t14_code = data.t14_code,
      premier_code = data.premier_code,
      "partsEngine_code" = data."partsEngine_code",
      tdot_url = data.tdot_url,
      "keystone_code_site" = data."keystone_code_site",
      "keystone_ftp_brand" = data."keystone_ftp_brand",
      ctp_code = data.ctp_code,
      omix_code = data.omix_code,
      brand_name = data.brand_name,
      vendors = data.vendors
    FROM data
    WHERE p.sku = data.sku
  `;
};

const seedVendorPrefixFast = async () => {
  const startedAt = Date.now();
  let totalProcessed = 0;
  let lastSku = null;

  try {
    console.log(`🚀 Fast vendor-prefix refresh started (batch size: ${BATCH_SIZE})`);

    while (true) {
      const products = await prisma.product.findMany({
        select: { sku: true },
        orderBy: { sku: "asc" },
        take: BATCH_SIZE,
        ...(lastSku ? { cursor: { sku: lastSku }, skip: 1 } : {}),
      });

      if (!products.length) break;

      const rowsToUpdate = products.map((p) => buildPrefixDerivedFields(p.sku));
      await bulkUpdateProducts(rowsToUpdate);

      totalProcessed += rowsToUpdate.length;
      lastSku = products[products.length - 1].sku;
      console.log(`Updated ${totalProcessed.toLocaleString()} products...`);
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`✅ Fast vendor-prefix refresh completed: ${totalProcessed.toLocaleString()} products in ${durationSec}s`);
  } catch (error) {
    console.error("❌ Fast vendor-prefix refresh failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

module.exports = seedVendorPrefixFast;

if (require.main === module) {
  seedVendorPrefixFast();
}
