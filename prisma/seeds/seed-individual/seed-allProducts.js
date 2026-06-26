/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const axios = require("axios");

const magentoAllProducts = require("../api-calls/magento-allProducts.js");
const quadratecCost = require("../api-calls/quadratec-excel.js");
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const prisma = require("../../../lib/prisma");

const KEYSTONE_FILES_DIR = path.resolve(__dirname, "../api-calls/keystone_files");
const KEYSTONE_FILES = ["Inventory.csv", "SpecialOrder.csv"];

const MEYER_CODE_OVERRIDES_BY_SKU = {
  "BAJ-447723": "BAJ44-7723",
  "BST-5493035": "BES5493035",
  "BST-5493017": "BES5493017",
};

const getProductCreateFieldSet = () => {
  try {
    const dmmfModel = prisma?._dmmf?.datamodel?.models?.find((m) => m.name === "Product");
    if (dmmfModel?.fields?.length) {
      return new Set(dmmfModel.fields.map((f) => f.name));
    }
  } catch (_) {
    // no-op: fallback below
  }
  return null;
};

const productCreateFieldSet = getProductCreateFieldSet();

const parseUnknownArgFieldsFromPrismaError = (error) => {
  const message = String(error?.message || "");
  const fields = new Set();
  const regex = /Unknown arg `([^`]+)`/g;
  let match;

  while ((match = regex.exec(message)) !== null) {
    if (match[1]) {
      fields.add(match[1]);
    }
  }

  return [...fields];
};

const sanitizeCreateRowsForClient = (rows) => {
  if (!productCreateFieldSet) return rows;

  const supportsKeystoneBrand = productCreateFieldSet.has("keystone_brand_code");
  const supportsKeystoneQb = productCreateFieldSet.has("keystone_qb_code");

  if (!supportsKeystoneBrand || !supportsKeystoneQb) {
    console.warn(
      "⚠️ Active Prisma Client is missing Product create fields for keystone_brand_code and/or keystone_qb_code. " +
        "Falling back to compatible createMany payload (update path still writes full fields)."
    );
  }

  return rows.map((row) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(row)) {
      if (productCreateFieldSet.has(key)) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
};

const sanitizeCreateRowsByBlockedFields = (rows, blockedFields) => {
  if (!blockedFields || blockedFields.size === 0) return rows;

  return rows.map((row) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(row)) {
      if (!blockedFields.has(key)) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  });
};

const createManyWithUnknownArgFallback = async (rows, batchLabel) => {
  let payload = sanitizeCreateRowsForClient(rows);
  const blockedFields = new Set();
  const maxUnknownArgRetries = 3;

  for (let attempt = 1; attempt <= maxUnknownArgRetries; attempt++) {
    try {
      await prisma.product.createMany({
        data: payload,
        skipDuplicates: true,
      });
      return;
    } catch (error) {
      const unknownFields = parseUnknownArgFieldsFromPrismaError(error);
      if (!unknownFields.length || attempt === maxUnknownArgRetries) {
        throw error;
      }

      for (const field of unknownFields) blockedFields.add(field);
      console.warn(
        `⚠️ ${batchLabel}: Prisma createMany rejected field(s): ${unknownFields.join(", ")}. ` +
          "Retrying batch without unsupported field(s)."
      );
      payload = sanitizeCreateRowsByBlockedFields(payload, blockedFields);
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryablePrismaError = (error) => {
  if (!error) return false;
  if (error.code === "P1017") return true; // server closed connection
  return (
    typeof error.message === "string" &&
    error.message.includes("Server has closed the connection")
  );
};

const safeNumber = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toStringOrNull = (v) => {
  if (v === "" || v === undefined) return null;
  if (v === null) return null;
  return String(v);
};

const cleanCsvField = (v) => {
  if (v === null || v === undefined) return "";
  let s = String(v).trim();
  if (!s) return "";
  if (/^=\s*".*"$/.test(s)) s = s.replace(/^=\s*"(.*)"$/, "$1");
  return s.replace(/^"+|"+$/g, "").trim();
};

const normalizeCode = (value) => {
  if (!value) return "";
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
};

const getCsvField = (row, ...names) => {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
  }
  return undefined;
};

const buildKeystoneBrandCodeLookup = async () => {
  const lookup = new Map();
  const summary = [];

  for (const fileName of KEYSTONE_FILES) {
    const filePath = path.join(KEYSTONE_FILES_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Keystone file not found: ${filePath}`);
      summary.push({ file: fileName, parsed: 0, mapped: 0, skippedMissingVendorName: 0 });
      continue;
    }

    const fileSummary = { file: fileName, parsed: 0, mapped: 0, skippedMissingVendorName: 0 };

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (row) => {
          fileSummary.parsed += 1;

          const vendorCodeRaw = cleanCsvField(
            getCsvField(row, "VendorCode", "Vendor Code", "Vendor", "VENDOR")
          );
          const vendorNameRaw = cleanCsvField(
            getCsvField(row, "VendorName", "Vendor Name", "Brand", "Manufacturer")
          );
          const vcpnRaw = cleanCsvField(
            getCsvField(row, "VCPN", "vcPn", "VcPn", "KeystonePN", "KeystoneCode", "Keystone_Code")
          );
          const partNumberRaw = cleanCsvField(
            getCsvField(row, "PartNumber", "Part Number", "PARTNUMBER", "PartNo", "Part #", "PN")
          );

          const vendorCode = normalizeCode(vendorCodeRaw);
          if (!vendorCode) return;

          if (!vendorNameRaw) {
            fileSummary.skippedMissingVendorName += 1;
            return;
          }

          let vcpn = normalizeCode(vcpnRaw);
          if (!vcpn && partNumberRaw) {
            vcpn = normalizeCode(`${vendorCode}${partNumberRaw}`);
          }

          if (!vcpn) return;
          if (lookup.has(vcpn)) return;

          lookup.set(vcpn, vendorNameRaw);
          fileSummary.mapped += 1;
        })
        .on("end", resolve)
        .on("error", reject);
    });

    summary.push(fileSummary);
  }

  console.log("🧩 Keystone brand-name lookup summary:", summary);
  console.log(`✅ Keystone VCPN -> VendorName mappings: ${lookup.size.toLocaleString()}`);

  return lookup;
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

const getCustomAttr = (custom_attributes, code) => {
  if (!custom_attributes) return "";
  return (
    Object.keys(custom_attributes).reduce((acc, key) => {
      if (custom_attributes[key]?.attribute_code === code) {
        return custom_attributes[key]?.value || "";
      }
      return acc;
    }, "") || ""
  );
};

const getMagentoBaseUrl = () => {
  const configured = process.env.MAGENTO_BASE_URL || process.env.M2_BASE_URL;
  if (!configured) return "https://www.justjeeps.com";
  return String(configured).trim().replace(/\/+$/, "") || "https://www.justjeeps.com";
};

const buildMagentoAttributeOptionLookup = async (attributeCode) => {
  const apiKey = process.env.MAGENTO_KEY;
  if (!apiKey) {
    console.warn(`⚠️ MAGENTO_KEY missing, cannot resolve labels for attribute "${attributeCode}".`);
    return new Map();
  }

  const baseUrl = getMagentoBaseUrl();
  const url = `${baseUrl}/rest/V1/products/attributes/${encodeURIComponent(attributeCode)}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 30000,
    });

    const options = Array.isArray(response?.data?.options) ? response.data.options : [];
    const lookup = new Map();

    for (const option of options) {
      const value = toStringOrNull(option?.value);
      const label = toStringOrNull(option?.label);
      if (!value || !label) continue;
      lookup.set(value.trim(), label.trim());
    }

    console.log(
      `✅ Magento attribute "${attributeCode}" options loaded: ${lookup.size.toLocaleString()}`
    );
    return lookup;
  } catch (error) {
    console.warn(
      `⚠️ Failed to load Magento attribute options for "${attributeCode}": ${
        error?.response?.status || error?.code || error?.message || "unknown error"
      }`
    );
    return new Map();
  }
};

const mapMagentoOptionValueToLabel = (rawValue, optionLookup) => {
  const value = toStringOrNull(rawValue);
  if (!value) return null;

  if (!(optionLookup instanceof Map) || optionLookup.size === 0) {
    return value;
  }

  const parts = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (!parts.length) return value;

  const mapped = parts.map((token) => optionLookup.get(token) || token);
  return mapped.join(", ");
};

const buildQuadratecPnLookup = async () => {
  const rows = await quadratecCost();
  const lookup = new Map();

  for (const row of rows) {
    const quadratecPn = toStringOrNull(row?.quadratec_sku);
    if (!quadratecPn) continue;

    const codes = [
      row?.quadratec_code,
      row?.quadratec_code_alt,
      row?.quadratec_code_alt2,
      row?.quadratec_code_alt3,
      row?.quadratec_code_alt4,
      row?.quadratec_code_alt5,
      row?.quadratec_code_alt6,
      row?.quadratec_code_alt7,
      row?.quadratec_code_alt8,
      row?.quadratec_code_alt9,
      row?.quadratec_code_alt10,
      row?.quadratec_code_alt11,
      row?.quadratec_code_alt12,
    ];

    for (const codeRaw of codes) {
      const code = toStringOrNull(codeRaw);
      if (!code) continue;
      lookup.set(code, quadratecPn);
    }
  }

  return lookup;
};

const buildRowFromMagento = (
  item,
  quadratecPnLookup = new Map(),
  keystoneBrandCodeLookup = new Map(),
  partOptionLookup = new Map()
) => {
  const { sku, status, name, price, weight, media_gallery_entries, custom_attributes } = item;

  const jjPrefix = sku.split("-")[0];
  const searchable_sku = sku.includes("-") ? sku.slice(sku.indexOf("-") + 1) : sku;

  const vendorData = vendorsPrefix.find((vendor) => vendor.jj_prefix === jjPrefix);

  // Meyer code
  let meyerCode =
    vendorData && vendorData.meyer_code
      ? (vendorData.meyer_code + searchable_sku).toUpperCase()
      : "";

  // BESTOP: add hyphen after first 5 digits (except 5240711)
  if (jjPrefix === "BST") {
    if (searchable_sku === "5240711") {
      meyerCode = (vendorData?.meyer_code || "") + searchable_sku;
    } else {
      meyerCode =
        (vendorData?.meyer_code || "") +
        searchable_sku.slice(0, 5) +
        "-" +
        searchable_sku.slice(5);
    }
  }

  // YUKON: remove spaces + uppercase
  if (jjPrefix === "YUK") {
    meyerCode = ((vendorData?.meyer_code || "") + searchable_sku).replace(/\s+/g, "").toUpperCase();
  }

  // Canonical Meyer-code overrides for known vendor edge cases.
  const meyerCodeOverride = MEYER_CODE_OVERRIDES_BY_SKU[String(sku).toUpperCase()];
  if (meyerCodeOverride) {
    meyerCode = meyerCodeOverride;
  }

  // Keystone code
  const keystoneSearchableSku = normalizeKeystoneSearchableSku(jjPrefix, searchable_sku);
  const normalizedKeystoneSku = keystoneSearchableSku.replace(/[-./_]/g, "");
  let keystoneCode =
    vendorData && vendorData.keystone_code
      ? jjPrefix === "MKT"
        ? vendorData.keystone_code + searchable_sku.slice(-6)
        : vendorData.keystone_code + normalizedKeystoneSku
      : "";

  // CARGOGLIDE: keystone_code => "CG" + remove hyphens
  if (jjPrefix === "CGG") {
    keystoneCode = "CG" + searchable_sku.replace(/-/g, "");
  }

  // Quadratec
  const quadratecCode =
    vendorData && vendorData.quadratec_code ? vendorData.quadratec_code + searchable_sku : "";
  const quadratecPn = quadratecPnLookup.get(quadratecCode) || null;

  // TDOT code (space between prefix and sku)
  const tdotCode =
    vendorData && vendorData.tdot_code ? vendorData.tdot_code + " " + searchable_sku : "";

  // CTP
  const ctpCode = vendorData && vendorData.ctp_code ? vendorData.ctp_code + searchable_sku : "";

  // PartsEngine URL (replace . / _ space with dash)
  let cleanedSearchableSku = searchable_sku.replace(/[./_\s]/g, "-");
  if (jjPrefix === "BST") {
    cleanedSearchableSku = cleanedSearchableSku.replace(/(\d+)(\d{2})$/, "$1-$2");
  }
  const partsEngineCode =
    vendorData && vendorData.partsEngine_code
      ? `https://www.partsengine.ca/${cleanedSearchableSku}${vendorData.partsEngine_code}`
      : "";

  // TDOT URL
  const tdotUrl =
    tdotCode && tdotCode.trim() !== ""
      ? `https://www.tdotperformance.ca/catalogsearch/result/?q=${searchable_sku}`
      : null;

  // Keystone site code
  let keystoneCodeSite =
    vendorData && vendorData.keystone_code_site
      ? vendorData.keystone_code_site + keystoneSearchableSku
      : "";

  if (jjPrefix === "YUK") {
    keystoneCodeSite = keystoneCode || "";
  }

  const keystoneFtpBrand =
    vendorData && vendorData.keystone_ftp_brand ? vendorData.keystone_ftp_brand : null;

  // Turn14 / Premier
  const t14Code = vendorData && vendorData.t14_code ? vendorData.t14_code + searchable_sku : "";
  const premierCode =
    vendorData && vendorData.premier_code ? vendorData.premier_code + searchable_sku : "";

  const brandName = vendorData ? vendorData.brand_name : "";
  const vendors = vendorData ? vendorData.vendors : "";
  const keystoneBrandCode =
    keystoneBrandCodeLookup.get(normalizeCode(keystoneCode)) ||
    toStringOrNull(vendorData?.brand_name) ||
    "";
  const keystoneQbCode = keystoneBrandCode ? `${keystoneBrandCode}${normalizedKeystoneSku}` : "";

  // Magento custom attrs
  const searchableSkuRaw = getCustomAttr(custom_attributes, "searchable_sku");
  const url_key = getCustomAttr(custom_attributes, "url_key");

  const length = getCustomAttr(custom_attributes, "length");
  const width = getCustomAttr(custom_attributes, "width");
  const height = getCustomAttr(custom_attributes, "height");
  const shippingFreight = getCustomAttr(custom_attributes, "shipping_freight");
  const partRaw = getCustomAttr(custom_attributes, "part");
  const part = mapMagentoOptionValueToLabel(partRaw, partOptionLookup);
  const thumbnail = getCustomAttr(custom_attributes, "thumbnail");

  // Black Friday Sale mapping
  const saleCategoryValue = getCustomAttr(custom_attributes, "black_friday_sale_attribute");
  let blackFridaySale = "15%off";
  if (saleCategoryValue === "4556") blackFridaySale = "20%off";
  else if (saleCategoryValue === "4557") blackFridaySale = "25%off";
  else if (saleCategoryValue === "4558") blackFridaySale = "30%off";

  // Image/url_path
  const image =
    media_gallery_entries && media_gallery_entries.length > 0
      ? `https://www.justjeeps.com/pub/media/catalog/product/${
          media_gallery_entries[0]?.file || null
        }`
      : null;

  const url_path = url_key ? `https://www.justjeeps.com/${url_key}.html` : null;

  // IMPORTANT: searchableSku is required in Prisma schema
  // Fallback order: custom attr -> searchable_sku -> sku
  const searchableSku =
    (searchableSkuRaw && String(searchableSkuRaw)) ||
    (searchable_sku && String(searchable_sku)) ||
    String(sku);

  return {
    sku: String(sku),
    name: String(name || ""),
    status: status === undefined ? null : Number(status),
    price: Number(price),
    weight: safeNumber(weight),

    length: safeNumber(length),
    width: safeNumber(width),
    height: safeNumber(height),

    shippingFreight: shippingFreight ? String(shippingFreight) : null,
    part: part ? String(part) : null,
    thumbnail: thumbnail ? String(thumbnail) : null,

    searchableSku,
    searchable_sku: toStringOrNull(searchable_sku),

    jj_prefix: toStringOrNull(jjPrefix),
    meyer_code: toStringOrNull(meyerCode),
    keystone_code: toStringOrNull(keystoneCode),
    keystone_brand_code: toStringOrNull(keystoneBrandCode),
    keystone_qb_code: toStringOrNull(keystoneQbCode),
    quadratec_code: toStringOrNull(quadratecCode),
    quadratec_pn: toStringOrNull(quadratecPn),
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
        ? normalizeOmixCode(searchable_sku)
        : null,

    brand_name: toStringOrNull(brandName),
    vendors: toStringOrNull(vendors),
    black_friday_sale: toStringOrNull(blackFridaySale),

    image: toStringOrNull(image),
    url_path: toStringOrNull(url_path),
  };
};

const pickRandomItems = (items, count) => {
  if (!items.length) return [];
  const max = Math.min(count, items.length);
  const chosen = new Set();
  const results = [];
  while (results.length < max) {
    const idx = Math.floor(Math.random() * items.length);
    if (!chosen.has(idx)) {
      chosen.add(idx);
      results.push(items[idx]);
    }
  }
  return results;
};

const seedAllProducts = async () => {
  const startTime = Date.now();
  console.time("seed-allProducts total");

  // ---- Checkpoint/resume settings (same idea as your original) ----
  const checkpointPath = path.join(__dirname, "..", "logs", "seed-allProducts.checkpoint.json");
  const resumeEnabled =
    process.env.SEED_ALLPRODUCTS_RESUME === "1" || process.env.SEED_ALLPRODUCTS_RESUME === "true";
  const checkpointEvery = Number(process.env.SEED_ALLPRODUCTS_CHECKPOINT_EVERY || 2000); // (fewer writes)
  const maxRetries = Number(process.env.SEED_ALLPRODUCTS_RETRY_MAX || 5);
  const baseRetryDelayMs = Number(process.env.SEED_ALLPRODUCTS_RETRY_DELAY_MS || 500);

  // ---- Batch settings ----
  const batchSize = Number(process.env.SEED_ALLPRODUCTS_BATCH_SIZE || 1000);

  let resumeIndex = 0;
  let createdCount = 0;
  let updatedCount = 0;

  if (resumeEnabled && fs.existsSync(checkpointPath)) {
    try {
      const checkpointRaw = fs.readFileSync(checkpointPath, "utf8");
      const checkpointData = JSON.parse(checkpointRaw);
      if (typeof checkpointData.lastIndex === "number") {
        resumeIndex = checkpointData.lastIndex + 1;
        createdCount = Number(checkpointData.createdCount || 0);
        updatedCount = Number(checkpointData.updatedCount || 0);
        console.log(
          `↩️ Resuming from checkpoint index ${resumeIndex} (sku ${checkpointData.lastSku || "unknown"}).`
        );
      }
    } catch (e) {
      console.warn("⚠️ Failed to read checkpoint file. Starting from the beginning.");
    }
  }

  const shouldWriteCheckpoint = (index, total) =>
    checkpointEvery > 0 && ((index + 1) % checkpointEvery === 0 || index === total - 1);

  const writeCheckpoint = (index, sku) => {
    const checkpointPayload = {
      lastIndex: index,
      lastSku: sku,
      createdCount,
      updatedCount,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpointPayload, null, 2), "utf8");
  };

  const runWithRetry = async (operation, context) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryablePrismaError(error) || attempt === maxRetries) throw error;

        const delayMs = baseRetryDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `⚠️ Retrying prisma error (attempt ${attempt}/${maxRetries}) for ${context} in ${delayMs}ms.`
        );

        try {
          await prisma.$disconnect();
          await prisma.$connect();
        } catch (reconnectError) {
          console.warn("⚠️ Reconnect attempt failed. Will retry anyway.");
        }

        await sleep(delayMs);
      }
    }
  };

  // ---- Bulk UPDATE using json_to_recordset (fast + safe) ----
  // Updates only rows that already exist.
  const bulkUpdateProducts = async (rowsToUpdate) => {
    if (!rowsToUpdate.length) return;

    // Keep only DB columns we actually update
    const payload = rowsToUpdate.map((r) => ({
      sku: r.sku,
      name: r.name,
      status: r.status,
      price: r.price,
      weight: r.weight,
      length: r.length,
      width: r.width,
      height: r.height,
      shippingFreight: r.shippingFreight,
      part: r.part,
      thumbnail: r.thumbnail,
      searchableSku: r.searchableSku,
      searchable_sku: r.searchable_sku,
      jj_prefix: r.jj_prefix,
      meyer_code: r.meyer_code,
      keystone_code: r.keystone_code,
      keystone_brand_code: r.keystone_brand_code,
      keystone_qb_code: r.keystone_qb_code,
      quadratec_code: r.quadratec_code,
      quadratec_pn: r.quadratec_pn,
      tdot_code: r.tdot_code,
      t14_code: r.t14_code,
      premier_code: r.premier_code,
      partsEngine_code: r.partsEngine_code,
      tdot_url: r.tdot_url,
      keystone_code_site: r.keystone_code_site,
      keystone_ftp_brand: r.keystone_ftp_brand,
      ctp_code: r.ctp_code,
      omix_code: r.omix_code,
      brand_name: r.brand_name,
      vendors: r.vendors,
      black_friday_sale: r.black_friday_sale,
      image: r.image,
      url_path: r.url_path,
    }));

    const json = JSON.stringify(payload);

    // NOTE: Prisma maps model Product -> table "Product"
    // Column names match your Prisma schema exactly (camelCase preserved).
    await prisma.$executeRaw`
      WITH data AS (
        SELECT *
        FROM json_to_recordset(${json}::json) AS x(
          sku text,
          name text,
          status int,
          price double precision,
          weight double precision,
          length double precision,
          width double precision,
          height double precision,
          "shippingFreight" text,
          part text,
          thumbnail text,
          "searchableSku" text,
          searchable_sku text,
          jj_prefix text,
          meyer_code text,
          keystone_code text,
          keystone_brand_code text,
          keystone_qb_code text,
          quadratec_code text,
          quadratec_pn text,
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
          vendors text,
          "black_friday_sale" text,
          image text,
          url_path text
        )
      )
      UPDATE "Product" p
      SET
        name = data.name,
        status = data.status,
        price = data.price,
        weight = data.weight,
        length = data.length,
        width = data.width,
        height = data.height,
        "shippingFreight" = data."shippingFreight",
        part = data.part,
        thumbnail = data.thumbnail,
        "searchableSku" = data."searchableSku",
        searchable_sku = data.searchable_sku,
        jj_prefix = data.jj_prefix,
        meyer_code = data.meyer_code,
        keystone_code = data.keystone_code,
        keystone_brand_code = data.keystone_brand_code,
        keystone_qb_code = data.keystone_qb_code,
        quadratec_code = data.quadratec_code,
        quadratec_pn = data.quadratec_pn,
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
        vendors = data.vendors,
        "black_friday_sale" = data."black_friday_sale",
        image = data.image,
        url_path = data.url_path
      FROM data
      WHERE p.sku = data.sku
    `;
  };

  try {
    console.log("🚀 Seeding Products from Magento...");
    console.time("fetch magento products");
    const allProducts = await magentoAllProducts();
    console.timeEnd("fetch magento products");

    console.time("fetch quadratec pn lookup");
    const quadratecPnLookup = await buildQuadratecPnLookup();
    console.timeEnd("fetch quadratec pn lookup");
    console.log(`✅ Quadratec PN code mappings: ${quadratecPnLookup.size.toLocaleString()}`);

    console.time("fetch keystone brand-code lookup");
    const keystoneBrandCodeLookup = await buildKeystoneBrandCodeLookup();
    console.timeEnd("fetch keystone brand-code lookup");

    console.time('fetch magento part option lookup');
    const partOptionLookup = await buildMagentoAttributeOptionLookup("part");
    console.timeEnd('fetch magento part option lookup');

    console.log(`✅ Magento rows received: ${allProducts.length.toLocaleString()}`);
    const usable = allProducts.filter((p) => p && p.sku);
    console.log(`✅ Rows usable (have sku): ${usable.length.toLocaleString()}`);

    const total = usable.length;
    const totalBatches = Math.ceil(total / batchSize);

    const t0 = Date.now();
    let processed = 0;

    for (let b = 0; b < totalBatches; b++) {
      const start = b * batchSize;
      const end = Math.min(start + batchSize, total);

      if (resumeEnabled && end - 1 < resumeIndex) {
        // Entire batch before resume index
        continue;
      }

      const slice = usable.slice(start, end);

      // Build transformed rows (same logic as original)
      const rows = slice.map((item) =>
        buildRowFromMagento(item, quadratecPnLookup, keystoneBrandCodeLookup, partOptionLookup)
      );

      // If resume enabled, drop rows before resumeIndex inside this batch
      let rowsToProcess = rows;
      if (resumeEnabled && resumeIndex > start) {
        const offset = Math.max(0, resumeIndex - start);
        rowsToProcess = rows.slice(offset);
      }

      const skus = rowsToProcess.map((r) => r.sku);

      // Find which SKUs already exist (one query per batch)
      const existing = await runWithRetry(
        () =>
          prisma.product.findMany({
            where: { sku: { in: skus } },
            select: { sku: true },
          }),
        `find existing skus batch ${b + 1}/${totalBatches}`
      );

      const existingSet = new Set(existing.map((e) => e.sku));
      const toCreate = [];
      const toUpdate = [];

      for (const r of rowsToProcess) {
        if (existingSet.has(r.sku)) toUpdate.push(r);
        else toCreate.push(r);
      }

      // Bulk create
      if (toCreate.length) {
        await runWithRetry(
          () => createManyWithUnknownArgFallback(toCreate, `createMany batch ${b + 1}/${totalBatches}`),
          `createMany batch ${b + 1}/${totalBatches}`
        );
        createdCount += toCreate.length;
      }

      // Bulk update
      if (toUpdate.length) {
        await runWithRetry(
          () => bulkUpdateProducts(toUpdate),
          `bulk update batch ${b + 1}/${totalBatches}`
        );
        updatedCount += toUpdate.length;
      }

      processed = Math.min(end, total);

      // Progress + ETA (Quad-style)
      const elapsedSec = (Date.now() - t0) / 1000;
      const rps = processed / Math.max(1, elapsedSec);
      const remaining = total - processed;
      const etaSec = remaining / Math.max(1, rps);

      console.log(
        `Batch ${b + 1}/${totalBatches} | ${processed}/${total} rows | ${rps.toFixed(
          1
        )} rows/s | ETA ~${Math.round(etaSec)}s | +${toCreate.length} created / +${
          toUpdate.length
        } updated`
      );

      // checkpoint writes
      const lastIndex = end - 1;
      const lastSku = usable[lastIndex]?.sku;
      if (lastSku && shouldWriteCheckpoint(lastIndex, total)) {
        writeCheckpoint(lastIndex, lastSku);
      }
    }

    console.log(
      `✅ Products seeded successfully!\nCreated: ${createdCount.toLocaleString()}\nUpdated: ${updatedCount.toLocaleString()}`
    );

    const dbCount = await runWithRetry(() => prisma.product.count(), "count products");
    console.log(
      `📊 Count check | DB total: ${dbCount.toLocaleString()} | Magento usable: ${total.toLocaleString()}`
    );

    const sampleItems = pickRandomItems(usable, 10);
    if (sampleItems.length) {
      const sampleSkus = sampleItems.map((item) => String(item.sku));
      const expectedBySku = new Map(
        sampleItems.map((item) => {
          const row = buildRowFromMagento(
            item,
            quadratecPnLookup,
            keystoneBrandCodeLookup,
            partOptionLookup
          );
          return [row.sku, row];
        })
      );

      const dbSamples = await runWithRetry(
        () =>
          prisma.product.findMany({
            where: { sku: { in: sampleSkus } },
            select: { sku: true, price: true, url_path: true, name: true, status: true },
          }),
        "sample sku fetch"
      );

      const comparison = dbSamples.map((row) => {
        const expected = expectedBySku.get(row.sku) || {};
        return {
          sku: row.sku,
          price_db: row.price,
          price_expected: expected.price,
          url_path_db: row.url_path,
          url_path_expected: expected.url_path,
          name_db: row.name,
          name_expected: expected.name,
          status_db: row.status,
          status_expected: expected.status,
        };
      });

      console.log("🔎 Sample SKU field check (DB vs Magento expected):");
      for (const row of comparison) {
        console.log(
          `SKU ${row.sku}\n` +
            `  price:  db=${row.price_db} | magento=${row.price_expected}\n` +
            `  url:    db=${row.url_path_db} | magento=${row.url_path_expected}\n` +
            `  name:   db=${row.name_db} | magento=${row.name_expected}\n` +
            `  status: db=${row.status_db} | magento=${row.status_expected}\n`
        );
      }
    }
  } catch (error) {
    console.error("❌ seed-allProducts failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    console.timeEnd("seed-allProducts total");

    const durationMinutes = ((Date.now() - startTime) / 60000).toFixed(2);
    const statusLabel = process.exitCode === 1 ? "Seeding failed" : "Seeding completed";
    console.log(`${statusLabel} in ${durationMinutes} minutes.`);
  }
};

module.exports = seedAllProducts;

// Run directly
if (require.main === module) {
  seedAllProducts();
}



// const fs = require("fs");
// const path = require("path");

// const magentoAllProducts = require("../api-calls/magento-allProducts.js");
// const vendorsPrefix = require("../hard-code_data/vendors_prefix");

// const prisma = require("../../../lib/prisma");

// const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// const isRetryablePrismaError = (error) => {
//   if (!error) {
//     return false;
//   }

//   if (error.code === "P1017") {
//     return true;
//   }

//   return (
//     typeof error.message === "string" &&
//     error.message.includes("Server has closed the connection")
//   );
// };

// const seedAllProducts = async () => {
//   const startTime = Date.now();
//   console.time("Seed Duration"); // Start timer to measure seed duration

//   const checkpointPath = path.join(
//     __dirname,
//     "..",
//     "logs",
//     "seed-allProducts.checkpoint.json"
//   );
//   const resumeEnabled =
//     process.env.SEED_ALLPRODUCTS_RESUME === "1" ||
//     process.env.SEED_ALLPRODUCTS_RESUME === "true";
//   const checkpointEvery = Number(
//     process.env.SEED_ALLPRODUCTS_CHECKPOINT_EVERY || 50
//   );
//   const maxRetries = Number(process.env.SEED_ALLPRODUCTS_RETRY_MAX || 5);
//   const baseRetryDelayMs = Number(
//     process.env.SEED_ALLPRODUCTS_RETRY_DELAY_MS || 500
//   );
//   let resumeIndex = 0;

//   if (resumeEnabled && fs.existsSync(checkpointPath)) {
//     try {
//       const checkpointRaw = fs.readFileSync(checkpointPath, "utf8");
//       const checkpointData = JSON.parse(checkpointRaw);
//       if (typeof checkpointData.lastIndex === "number") {
//         resumeIndex = checkpointData.lastIndex + 1;
//         console.log(
//           `Resuming from checkpoint index ${resumeIndex} (sku ${checkpointData.lastSku || "unknown"}).`
//         );
//       }
//     } catch (error) {
//       console.warn("Failed to read checkpoint file. Starting from the beginning.");
//     }
//   }

//   const runWithRetry = async (operation, context) => {
//     for (let attempt = 1; attempt <= maxRetries; attempt++) {
//       try {
//         return await operation();
//       } catch (error) {
//         if (!isRetryablePrismaError(error) || attempt === maxRetries) {
//           throw error;
//         }

//         const delayMs = baseRetryDelayMs * Math.pow(2, attempt - 1);
//         console.warn(
//           `Retrying after prisma error (attempt ${attempt}/${maxRetries}) for ${context} in ${delayMs}ms.`
//         );
//         try {
//           await prisma.$disconnect();
//           await prisma.$connect();
//         } catch (reconnectError) {
//           console.warn("Reconnect attempt failed. Will retry anyway.");
//         }
//         await sleep(delayMs);
//       }
//     }
//   };
  
//   try {
//     const allProducts = await magentoAllProducts();
//     // console.log("allProducts", allProducts);
//     console.log(`✅ Total collected items: ${allProducts.length}`);


//     // Initialize counters for created and updated products
//     let createdCount = 0;
//     let updatedCount = 0;

//     const shouldWriteCheckpoint = (index) =>
//       checkpointEvery > 0 &&
//       ((index + 1) % checkpointEvery === 0 || index === allProducts.length - 1);

//     const writeCheckpoint = (index, sku, created, updated) => {
//       const checkpointPayload = {
//         lastIndex: index,
//         lastSku: sku,
//         createdCount: created,
//         updatedCount: updated,
//         updatedAt: new Date().toISOString(),
//       };
//       fs.writeFileSync(
//         checkpointPath,
//         JSON.stringify(checkpointPayload, null, 2),
//         "utf8"
//       );
//     };

//     for (let index = 0; index < allProducts.length; index++) {
//       if (resumeEnabled && index < resumeIndex) {
//         continue;
//       }

//       const item = allProducts[index];
//       const {
//         sku,
//         status,
//         name,
//         price,
//         weight,
//         media_gallery_entries,
//         custom_attributes,
//       } = item;
//       // console.log("item", item);

//       // Extract jj_prefix from sku by splitting at the first hyphen and taking the first element
//       const jjPrefix = item.sku.split("-")[0];

//       // Extract searchable_sku from sku by removing characters before the first hyphen
//       const searchable_sku = item.sku.slice(item.sku.indexOf("-") + 1);

//       // Get the vendor data based on jj_prefix
//       const vendorData = vendorsPrefix.find(
//         (vendor) => vendor.jj_prefix === jjPrefix
//       );


//       // Generate meyer_code, keystone_code, and brand_name based on vendor data
//       // let meyerCode =
//       //   vendorData && vendorData.meyer_code
//       //     ? vendorData.meyer_code + searchable_sku
//       //     : "";

//       let meyerCode =
//         vendorData && vendorData.meyer_code
//           ? (vendorData.meyer_code + searchable_sku).toUpperCase()
//           : "";



//       //BESTOP: FOR MEYRcode, add hyphen after the 5 first digits from searchable_sku
//       if (jjPrefix === "BST") {
//         // Special case for SKU 5240711 - no hyphen formatting
//         if (searchable_sku === "5240711") {
//           meyerCode = vendorData.meyer_code + searchable_sku;
//         } else {
//           meyerCode = vendorData.meyer_code + searchable_sku.slice(0, 5) + "-" + 
//           searchable_sku.slice(5);
//         }
//       }

//       // YUKON: remove all spaces from meyer_code
//         if (jjPrefix === "YUK") {
//           meyerCode = (vendorData.meyer_code + searchable_sku)
//             .replace(/\s+/g, "") // removes all spaces
//             .toUpperCase();
//         }

//       //CARGOGLIDE: JJ_PREFIX =CGG, FOR KEYSTONE_CODE, remove hyphen from searchable_sku and it should be afte CG. Example is searchable_sku = CG-1000-90, keystone_code = 100090

   


//       //Generate keystone_code based on vendor data

//       // CODE FOR MICKEY THOMPSON - 3 CODES FROM KEYSTONE
//       //     const keystoneCode =
//       // vendorData && vendorData.keystone_code
//       //   ? jjPrefix === "MKT"
//       //     ? vendorData.keystone_code + searchable_sku.slice(-6).replace(/[-.]/g, "")
//       //     : vendorData.keystone_code + searchable_sku.replace(/[-.]/g, "")
//       //   : "";

//       let keystoneCode =
//   vendorData && vendorData.keystone_code
//     ? jjPrefix === "MKT"
//       ? vendorData.keystone_code + searchable_sku.slice(-6)
//       : vendorData.keystone_code + searchable_sku.replace(/[-./_]/g, "")
//     : "";


//  // CARGOGLIDE: Format keystone_code (remove hyphens and place after "CG")
//     if (jjPrefix === "CGG") {
//     keystoneCode = "CG" + searchable_sku.replace(/-/g, "");
// }


//       // const keystoneCode =
//       //   vendorData && vendorData.keystone_code
//       //     ? vendorData.keystone_code +
//       //       searchable_sku.replace(/-/g, "").replace(/\./g, "")
//       //     : "";

//       //Generate quadratec_code based on vendor data
//       const quadratecCode =
//         vendorData && vendorData.quadratec_code
//           ? vendorData.quadratec_code + searchable_sku
//           : "";
//       // console.log("quadratecCode", quadratecCode);

//       //generate tdot_code based on competitor data, but we need a space between the prefix and the sku
//       const tdotCode =
//         vendorData && vendorData.tdot_code
//           ? vendorData.tdot_code + " " + searchable_sku
//           : "";

//     // Generate ctp_code based on vendor dataa
//       const ctpCode =
//         vendorData && vendorData.ctp_code
//           ? vendorData.ctp_code + searchable_sku
//           : "";
//       // console.log("ctpCode", ctpCode);

//       //Generate partsEngine_code based on vendor data
    
//       // Clean searchable_sku for PartsEngine (replace . / _ space with dash)

//       let cleanedSearchableSku = searchable_sku.replace(/[./_\s]/g, "-");

//       // Special rule for Bestop (BST): insert hyphen before last two digits
//       if (jjPrefix === "BST") {
//         cleanedSearchableSku = cleanedSearchableSku.replace(/(\d+)(\d{2})$/, "$1-$2");
//       }

//       const partsEngineCode =
//         vendorData && vendorData.partsEngine_code
//           ? `https://www.partsengine.ca/${cleanedSearchableSku}${vendorData.partsEngine_code}`
//           : "";


//       // Generate tdot_url only if tdot_code is not empty
//       const tdotUrl =
//       tdotCode && tdotCode.trim() !== ""
//         ? `https://www.tdotperformance.ca/catalogsearch/result/?q=${searchable_sku}`
//         : null;
      
//       // console.log("tdotUrl", tdotUrl);


//       //kestone_code_site
//       // Generate keystone_code_site based on vendor data
//       let keystoneCodeSite =
//         vendorData && vendorData.keystone_code_site
//           ? vendorData.keystone_code_site + searchable_sku
//           : "";

//       // Yukon override: keystone_code_site should come from the Keystone code

//       if (jjPrefix === "YUK") {
//         keystoneCodeSite = keystoneCode || "";
//       }
      
//       //keystone_ftp_brand
//       // Generate keystone_ftp_brand based on vendor data
//       const keystoneFtpBrand =
//         vendorData && vendorData.keystone_ftp_brand
//           ? vendorData.keystone_ftp_brand
//           : null;

//       // console.log("keystoneCodeSite", keystoneCodeSite);

      


//       // Generate gentecdirect_code based on vendor data
//       const gentecdirectCode =
//         vendorData && vendorData.gentecdirect_code
//           ? vendorData.gentecdirect_code + searchable_sku
//           : "";

//       // Generate t14_code based on vendor data (Turn14 Distribution)
//       const t14Code =
//         vendorData && vendorData.t14_code
//           ? vendorData.t14_code + searchable_sku
//           : "";
//       // console.log("t14Code", t14Code);

//       // Generate premier_code based on vendor data (Premier Performance)
//       const premierCode =
//         vendorData && vendorData.premier_code
//           ? vendorData.premier_code + searchable_sku
//           : "";
//       // console.log("premierCode", premierCode);     

//       //Generate brand_name based on vendor data
//       const brandName = vendorData ? vendorData.brand_name : "";

//       // Generate vendors based on vendor data
//       const vendors = vendorData ? vendorData.vendors : "";

//       const searchableSku =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "searchable_sku") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//       const url_path =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "url_key") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//       //get width, length, height from custom_attributes
//       const length =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "length") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//       const width =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "width") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//       const height =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "height") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//       //shipping_freight
//       const shippingFreight =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "shipping_freight") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//         //part
//         const part =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "part") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//         //thumbnail
//         const thumbnail =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "thumbnail") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//         // Black Friday Sale - extract the sale category value
//         const saleCategoryValue =
//         custom_attributes &&
//         Object.keys(custom_attributes).reduce((acc, key) => {
//           if (custom_attributes[key].attribute_code === "black_friday_sale_attribute") {
//             return custom_attributes[key].value || "";
//           }
//           return acc;
//         }, "");

//         // Determine Black Friday sale discount based on sale category value
//         let blackFridaySale = "15%off"; // Default value for empty or unmatched values
        
//         if (saleCategoryValue === "4556") {
//           blackFridaySale = "20%off";
//         } else if (saleCategoryValue === "4557") {
//           blackFridaySale = "25%off";
//         } else if (saleCategoryValue === "4558") {
//           blackFridaySale = "30%off";
//         }

        


//       // console.log("length", length);
//       // console.log("width", width);
//       // console.log("height", height);
//       // console.log("shippingFreight", shippingFreight);
//       // console.log("part", part);
//       // console.log("thumbnail", thumbnail);
//       // console.log("saleCategoryValue", saleCategoryValue);
//       // console.log("blackFridaySale", blackFridaySale);
//       // console.log("url_path", url_path);
//       // console.log("keystone_code_site", keystoneCodeSite);
//       // console.log("keystone_ftp_brand", keystoneFtpBrand);

//       // console.log("url_path", url_path);

//       // console.log("check sku", sku);
//       //console.log the product when sku is undefined
//       if (sku === undefined) {
//         // console.log("check item", item);
//       }
//       // Check if product with given SKU already exists in the database
//       const existingProduct = await prisma.product.findUnique({
//         where: { sku },
//       });

//       const productData = {
//         name,
//         status,
//         price,
//         weight,
//         //if length, width, height and shippingFreight are not undefined, parsefloat them or put them as NULL
//         length: length ? parseFloat(length) : null,
//         width: width ? parseFloat(width) : null,
//         height: height ? parseFloat(height) : null,
//         shippingFreight: shippingFreight ? shippingFreight : null,
//         part: part ? part : null,
//         thumbnail: thumbnail ? thumbnail : null,
//         searchableSku,
//         searchable_sku,
//         jj_prefix: jjPrefix,
//         meyer_code: meyerCode,
//         keystone_code: keystoneCode,
//         quadratec_code: quadratecCode,
//         tdot_code: tdotCode,
//         t14_code: t14Code,
//         premier_code: premierCode,
//         partsEngine_code: partsEngineCode,
//         tdot_url: tdotUrl,
//         keystone_code_site: keystoneCodeSite,
//         keystone_ftp_brand: keystoneFtpBrand,
//         ctp_code: ctpCode,
//         // gentecdirectCode: gentecdirect_code,
//         omix_code:
//           jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR" || jjPrefix === "HVC"
//             ? searchable_sku
//             : null,
//         brand_name: brandName,
//         vendors: vendors,
//         black_friday_sale: blackFridaySale,
//         // manufacturer_code: manufacturerCode,
//         image:
//           media_gallery_entries && media_gallery_entries.length > 0
//             ? `https://www.justjeeps.com/pub/media/catalog/product/${
//                 media_gallery_entries[0]?.file || null
//               }`
//             : null,
//         url_path: url_path ? `https://www.justjeeps.com/${url_path}.html` : null,
//       };

//       if (existingProduct) {
//         await runWithRetry(
//           () =>
//             prisma.product.update({
//               where: { sku },
//               data: productData,
//             }),
//           `update sku ${sku}`
//         );
//         updatedCount++; // Increment updated product counter
//       } else {
//         await runWithRetry(
//           () =>
//             prisma.product.create({
//               data: {
//                 sku,
//                 ...productData,
//               },
//             }),
//           `create sku ${sku}`
//         );
//         createdCount++; // Increment created product counter
//       }

//       if (shouldWriteCheckpoint(index)) {
//         writeCheckpoint(index, sku, createdCount, updatedCount);
//       }
//     }

//     console.log(`Products seeded successfully!! 
//     Total products created: ${createdCount}
//     Total products updated: ${updatedCount}`);
//   } catch (error) {
//     console.error("Error seeding data:", error);
//     process.exitCode = 1;
//   } finally {
//     await prisma.$disconnect();
//     const endTime = Date.now();
//     const durationMinutes = ((endTime - startTime) / 60000).toFixed(2);
//     const statusLabel = process.exitCode === 1 ? "Seeding failed" : "Seeding completed";
//     console.log(`${statusLabel} in ${durationMinutes} minutes.`);
//   }
// };

// module.exports = seedAllProducts;

// seedAllProducts();
