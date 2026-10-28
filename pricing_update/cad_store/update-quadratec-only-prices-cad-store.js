#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const { USD_TO_CAD_RATE } = require('../../utils/exchangeRate');

dotenv.config();

const VENDOR_ID = Number(process.env.PRICE_UPDATE_VENDOR_ID || 4);
const DEFAULT_VENDOR_NAME = process.env.PRICE_UPDATE_VENDOR_NAME || 'quadratec';
const JOB_LABEL = process.env.PRICE_UPDATE_JOB_LABEL || 'Quadratec-Only';
const DERIVE_USD_COST_FROM_CAD = process.env.PRICE_UPDATE_DERIVE_USD_COST_FROM_CAD === '1';
const STORE_ID_CAD = Number(process.env.CAD_STORE_ID || 0);
const STORE_ID_CAD_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);
const MIN_FINAL_MARGIN = 0.2;
const MIN_PRICE = 11.95;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalizeVendorName(value) {
  return (value || '').trim().toLowerCase();
}

function isSamePrice(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.00001;
}

async function fetchMagentoPriceBySku(sku) {
  const encodedSku = encodeURIComponent(String(sku || '').trim());
  const response = await axios.get(
    `${MAGENTO_CONFIG.baseURL}/products/${encodedSku}?fields=sku,price`,
    {
      headers: {
        Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      timeout: MAGENTO_CONFIG.timeout,
    }
  );

  const magentoPrice = Number(response.data?.price);
  return Number.isFinite(magentoPrice) ? magentoPrice : null;
}

async function checkMagentoProductExists(sku) {
  const encodedSku = encodeURIComponent(String(sku || '').trim());
  try {
    await axios.get(
      `${MAGENTO_CONFIG.baseURL}/products/${encodedSku}?fields=sku`,
      {
        headers: {
          Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
          'Content-Type': 'application/json',
        },
        timeout: MAGENTO_CONFIG.timeout,
      }
    );
    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      return false;
    }
    return null;
  }
}

async function classifyMissingMagentoSkus(rows) {
  const candidates = rows.filter((row) => row.existing_price_magento == null);
  if (candidates.length === 0) {
    return {
      missingInMagentoCount: 0,
      existenceUnknownCount: 0,
      missingSamples: [],
    };
  }

  const bySku = new Map();
  for (const row of candidates) {
    if (!bySku.has(row.sku)) {
      bySku.set(row.sku, row);
    }
  }

  const skus = Array.from(bySku.keys());
  let cursor = 0;
  const concurrency = Math.min(20, skus.length);

  let missingInMagentoCount = 0;
  let existenceUnknownCount = 0;
  const missingSamples = [];

  async function worker() {
    while (cursor < skus.length) {
      const index = cursor++;
      const sku = skus[index];
      const exists = await checkMagentoProductExists(sku);
      const row = bySku.get(sku);

      if (exists === false) {
        row.missing_in_magento = true;
        row.price_changed = false;
        row.magento_price_error = 'product not found in Magento (404)';
        missingInMagentoCount++;
        if (missingSamples.length < 20) {
          missingSamples.push({ sku, reason: row.magento_price_error });
        }
      } else if (exists == null) {
        row.missing_in_magento = false;
        row.price_changed = true;
        existenceUnknownCount++;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return {
    missingInMagentoCount,
    existenceUnknownCount,
    missingSamples,
  };
}

async function fetchMagentoBasePricesBySkus(skus) {
  const uniqueSkus = Array.from(new Set((skus || []).map((sku) => String(sku || '').trim()).filter(Boolean)));
  if (uniqueSkus.length === 0) {
    return {
      bySku: new Map(),
      failedSkuSet: new Set(),
      failedBatches: 0,
      errorSamples: [],
    };
  }

  const bySku = new Map();
  const failedSkuSet = new Set();
  const errorSamples = [];
  let failedBatches = 0;

  // Avoid oversized payloads that can fail in one shot for large catalogs.
  const lookupBatchSize = 500;
  const lookupBatches = chunk(uniqueSkus, lookupBatchSize);

  for (const batch of lookupBatches) {
    try {
      const response = await axios.post(
        `${MAGENTO_CONFIG.baseURL}/products/base-prices-information`,
        { skus: batch },
        {
          headers: {
            Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
            'Content-Type': 'application/json',
          },
          timeout: MAGENTO_CONFIG.timeout,
        }
      );

      const prices = Array.isArray(response.data) ? response.data : [];
      for (const item of prices) {
        const sku = String(item?.sku || '').trim();
        const storeId = Number(item?.store_id);
        const price = Number(item?.price);
        if (!sku || !Number.isInteger(storeId) || !Number.isFinite(price)) continue;

        if (!bySku.has(sku)) {
          bySku.set(sku, new Map());
        }
        bySku.get(sku).set(storeId, price);
      }
    } catch (error) {
      failedBatches++;
      for (const sku of batch) {
        failedSkuSet.add(sku);
      }

      if (errorSamples.length < 5) {
        const status = error.response?.status || 'ERR';
        const details = String(error.response?.data?.message || error.message || 'unknown').slice(0, 180);
        errorSamples.push({ status, details, batch_size: batch.length });
      }
    }
  }

  return {
    bySku,
    failedSkuSet,
    failedBatches,
    errorSamples,
  };
}

async function classifyRowsByMagentoPrice(rows, options = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  if (inputRows.length === 0) {
    return {
      rows: [],
      changedRows: [],
      unchangedRows: [],
      changedPriceCount: 0,
      unchangedPriceCount: 0,
      unresolvedMagentoPriceCount: 0,
      missingInMagentoCount: 0,
      existenceUnknownCount: 0,
      missingInMagentoSamples: [],
      magentoLookupFailedBatches: 0,
      magentoLookupErrorSamples: [],
      comparisonSource: 'none',
    };
  }

  // Fallback for dry-run environments where token is intentionally omitted.
  if (!MAGENTO_CONFIG.token) {
    const fallbackRows = inputRows.map((row) => {
      const existingPriceDb = Number(row.existing_price_db);
      const priceChanged = !Number.isFinite(existingPriceDb)
        ? true
        : !isSamePrice(existingPriceDb, row.price);
      return {
        ...row,
        existing_price_magento: null,
        price_changed: priceChanged,
      };
    });

    const changedRows = fallbackRows.filter((row) => row.price_changed);
    const unchangedRows = fallbackRows.filter((row) => !row.price_changed);

    return {
      rows: fallbackRows,
      changedRows,
      unchangedRows,
      changedPriceCount: changedRows.length,
      unchangedPriceCount: unchangedRows.length,
      unresolvedMagentoPriceCount: fallbackRows.length,
      missingInMagentoCount: 0,
      existenceUnknownCount: fallbackRows.length,
      missingInMagentoSamples: [],
      magentoLookupFailedBatches: 0,
      magentoLookupErrorSamples: [],
      comparisonSource: 'db-fallback',
    };
  }

  const outRows = inputRows.map((row) => ({
    ...row,
    existing_price_magento: null,
    existing_price_magento_store_id: STORE_ID_CAD,
    price_changed: true,
  }));

  let unresolvedMagentoPriceCount = 0;

  try {
    const {
      bySku,
      failedSkuSet,
      failedBatches,
      errorSamples,
    } = await fetchMagentoBasePricesBySkus(outRows.map((row) => row.sku));

    for (const row of outRows) {
      const priceByStore = bySku.get(row.sku);
      const magentoPrice = priceByStore?.get(STORE_ID_CAD);
      row.existing_price_magento = Number.isFinite(magentoPrice) ? magentoPrice : null;

      if (Number.isFinite(magentoPrice)) {
        row.price_changed = !isSamePrice(magentoPrice, row.price);
      } else {
        unresolvedMagentoPriceCount++;
        row.price_changed = true;
        if (failedSkuSet.has(row.sku)) {
          row.magento_price_error = 'base-prices-information lookup batch failed';
        }
      }
    }

    const {
      missingInMagentoCount,
      existenceUnknownCount,
      missingSamples,
    } = await classifyMissingMagentoSkus(outRows);

    const changedRows = outRows.filter((row) => row.price_changed && !row.missing_in_magento);
    const unchangedRows = outRows.filter((row) => !row.price_changed || row.missing_in_magento);

    return {
      rows: outRows,
      changedRows,
      unchangedRows,
      changedPriceCount: changedRows.length,
      unchangedPriceCount: unchangedRows.length,
      unresolvedMagentoPriceCount,
      missingInMagentoCount,
      existenceUnknownCount,
      missingInMagentoSamples: missingSamples,
      magentoLookupFailedBatches: failedBatches,
      magentoLookupErrorSamples: errorSamples,
      comparisonSource: failedBatches > 0 ? 'magento-partial' : 'magento',
    };
  } catch (error) {
    unresolvedMagentoPriceCount = outRows.length;
    for (const row of outRows) {
      row.price_changed = true;
      row.magento_price_error = String(error.response?.data?.message || error.message || 'unknown').slice(0, 160);
    }
  }

  const changedRows = outRows.filter((row) => row.price_changed);
  const unchangedRows = outRows.filter((row) => !row.price_changed);

  return {
    rows: outRows,
    changedRows,
    unchangedRows,
    changedPriceCount: changedRows.length,
    unchangedPriceCount: unchangedRows.length,
    unresolvedMagentoPriceCount,
    missingInMagentoCount: 0,
    existenceUnknownCount: outRows.length,
    missingInMagentoSamples: [],
    magentoLookupFailedBatches: 1,
    magentoLookupErrorSamples: [{
      status: error.response?.status || 'ERR',
      details: String(error.response?.data?.message || error.message || 'unknown').slice(0, 180),
      batch_size: outRows.length,
    }],
    comparisonSource: 'magento-failed',
  };
}

function parseArgs(argv) {
  const options = {
    vendorName: DEFAULT_VENDOR_NAME,
    sku: null,
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--vendor' && argv[i + 1]) {
      options.vendorName = argv[++i];
    } else if (arg === '--sku' && argv[i + 1]) {
      options.sku = String(argv[++i]).trim();
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--batch-size' && argv[i + 1]) {
      options.batchSize = Number(argv[++i]);
    } else if (arg === '--delay-ms' && argv[i + 1]) {
      options.delayMs = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function toCadStorePrice(vendorCostCad, vendorCostUsd) {
  const costCad = Number(vendorCostCad);
  const costUsd = Number.isFinite(Number(vendorCostUsd)) && Number(vendorCostUsd) > 0
    ? Number(vendorCostUsd)
    : DERIVE_USD_COST_FROM_CAD
      ? costCad / USD_TO_CAD_RATE
      : null;
  if (!Number.isFinite(costCad) || costCad <= 0) return null;
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;

  // USD cost decides the markup tier, but markup is applied to CAD cost.
  const markupMultiplier = costUsd < 100 ? 1.65 : 1.5;
  const roundedWhole = Math.round((costCad * markupMultiplier) / 0.85);
  const finalPrice = roundedWhole - 0.05;

  return {
    price: Number(finalPrice.toFixed(2)),
    markupMultiplier,
  };
}

function calculateFinalMargin(price, costCad) {
  const computedPrice = Number(price);
  const cost = Number(costCad);
  if (!Number.isFinite(computedPrice) || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  const margin = ((computedPrice * 0.85) - cost) / cost;
  return Number(margin.toFixed(4));
}

function forcePoint95Ending(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return value;
  return Number((Math.ceil(value + 0.05) - 0.05).toFixed(2));
}

function applyMinMarginFloor(price, costCad, minMargin = MIN_FINAL_MARGIN) {
  const cost = Number(costCad);
  const currentPrice = Number(price);

  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      price: currentPrice,
      marginFloorApplied: false,
    };
  }

  const currentMargin = calculateFinalMargin(currentPrice, cost);
  if (currentMargin == null || currentMargin >= minMargin) {
    return {
      price: currentPrice,
      marginFloorApplied: false,
    };
  }

  const requiredPrice = (cost * (1 + minMargin)) / 0.85;
  return {
    price: forcePoint95Ending(requiredPrice),
    marginFloorApplied: true,
  };
}

function applyMinPriceFloor(price, minPrice = MIN_PRICE) {
  const currentPrice = Number(price);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      price: currentPrice,
      minPriceFloorApplied: false,
    };
  }

  if (currentPrice >= minPrice) {
    return {
      price: currentPrice,
      minPriceFloorApplied: false,
    };
  }

  return {
    price: Number(minPrice.toFixed(2)),
    minPriceFloorApplied: true,
  };
}

async function getQuadratecOnlyPriceRows(vendorName, limit = null, sku = null) {
  const normalizedVendor = normalizeVendorName(vendorName);
  if (!normalizedVendor) {
    throw new Error('--vendor requires a non-empty value');
  }

  const skuFilter = String(sku || '').trim();

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      vendors: {
        equals: vendorName,
        mode: 'insensitive',
      },
      sku: {
        ...(skuFilter
          ? { equals: skuFilter }
          : {
            not: {
              endsWith: '-',
            },
          }),
      },
    },
    select: {
      sku: true,
      price: true,
      vendors: true,
      vendorProducts: {
        where: { vendor_id: VENDOR_ID },
        select: {
          vendor_cost: true,
          vendor_cost_usd: true,
          vendor_retail_price_usd: true,
        },
        take: 1,
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  let skippedVendorMismatch = 0;
  let skippedMissingCost = 0;
  let skippedInvalidPrice = 0;
  let under100MarkupCount = 0;
  let over100MarkupCount = 0;
  let rowsWithFinalMargin = 0;
  let minFinalMargin = null;
  let maxFinalMargin = null;
  let sumFinalMargin = 0;
  let minMarginFloorAppliedCount = 0;
  let minPriceFloorAppliedCount = 0;

  for (const product of products) {
    if (normalizeVendorName(product.vendors) !== normalizedVendor) {
      skippedVendorMismatch++;
      continue;
    }

    const vp = product.vendorProducts?.[0];
    if (!vp || vp.vendor_cost == null || (!DERIVE_USD_COST_FROM_CAD && vp.vendor_cost_usd == null)) {
      skippedMissingCost++;
      continue;
    }

    const result = toCadStorePrice(vp.vendor_cost, vp.vendor_cost_usd);
    if (result == null || result.price <= 0) {
      skippedInvalidPrice++;
      continue;
    }

    if (result.markupMultiplier === 1.65) {
      under100MarkupCount++;
    } else {
      over100MarkupCount++;
    }

    const floorAdjusted = applyMinMarginFloor(result.price, vp.vendor_cost);
    if (floorAdjusted.marginFloorApplied) {
      minMarginFloorAppliedCount++;
    }

    const minPriceAdjusted = applyMinPriceFloor(floorAdjusted.price);
    if (minPriceAdjusted.minPriceFloorApplied) {
      minPriceFloorAppliedCount++;
    }

    const finalMargin = calculateFinalMargin(minPriceAdjusted.price, vp.vendor_cost);
    if (finalMargin != null) {
      rowsWithFinalMargin++;
      sumFinalMargin += finalMargin;
      minFinalMargin = minFinalMargin == null ? finalMargin : Math.min(minFinalMargin, finalMargin);
      maxFinalMargin = maxFinalMargin == null ? finalMargin : Math.max(maxFinalMargin, finalMargin);
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_CAD,
      existing_price_db: product.price,
      price: minPriceAdjusted.price,
      vendor_cost: vp.vendor_cost,
      vendor_cost_usd: vp.vendor_cost_usd || (DERIVE_USD_COST_FROM_CAD ? Number((Number(vp.vendor_cost) / USD_TO_CAD_RATE).toFixed(4)) : vp.vendor_cost_usd),
      vendor_retail_price_usd: vp.vendor_retail_price_usd,
      final_margin: finalMargin,
      min_margin_floor_applied: floorAdjusted.marginFloorApplied,
      min_price_floor_applied: minPriceAdjusted.minPriceFloorApplied,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedVendorMismatch,
    skippedMissingCost,
    skippedInvalidPrice,
    under100MarkupCount,
    over100MarkupCount,
    rowsWithFinalMargin,
    avgFinalMargin: rowsWithFinalMargin > 0 ? Number((sumFinalMargin / rowsWithFinalMargin).toFixed(4)) : null,
    minFinalMargin,
    maxFinalMargin,
    minMarginFloorAppliedCount,
    minPriceFloorAppliedCount,
  };
}

async function postBasePricesBatch(prices) {
  const url = `${MAGENTO_CONFIG.baseURL}/products/base-prices`;
  const payload = { prices };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    maxBodyLength: Infinity,
    timeout: MAGENTO_CONFIG.timeout,
  });

  return response;
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) {
    out.push(array.slice(index, index + size));
  }
  return out;
}

function printUsage() {
  console.log(`Update Magento CAD store base prices for products where vendors is ${DEFAULT_VENDOR_NAME} only.`);
  console.log('Formula:');
  console.log('  - Tier decision uses vendor_cost_usd (<100 => 65%, >=100 => 50%)');
  if (DERIVE_USD_COST_FROM_CAD) {
    console.log(`  - If vendor_cost_usd is missing, derive USD cost from CAD cost / ${USD_TO_CAD_RATE}`);
  }
  console.log('  - Markup is applied to vendor_cost (CAD): round((vendor_cost * tier) / 0.85, 0) - 0.05');
  console.log(`  - Margin floor: if final margin < ${(MIN_FINAL_MARGIN * 100).toFixed(0)}%, lift to minimum and keep .95 ending`);
  console.log(`  - Min price floor: ${MIN_PRICE.toFixed(2)}`);
  console.log(`  - Primary store ID updated/compared: ${STORE_ID_CAD}`);
  console.log(`  - Mirror store ID also updated: ${STORE_ID_CAD_MIRROR}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/cad_store/update-quadratec-only-prices-cad-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --vendor <name>        Vendor value in Product.vendors (default: ${DEFAULT_VENDOR_NAME})`);
  console.log('  --sku <sku>            Restrict run to one SKU');
  console.log('  --limit <number>       Limit products fetched from DB');
  console.log('  --batch-size <number>  Prices per Magento request (default: 1000)');
  console.log('  --delay-ms <number>    Delay between batches in milliseconds (default: 400)');
  console.log('  --dry-run              Print sample payload only, do not send updates');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);

  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error('Invalid --batch-size. Expected integer >= 1.');
  }

  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error('Invalid --delay-ms. Expected integer >= 0.');
  }

  if (!options.dryRun && !MAGENTO_CONFIG.token) {
    throw new Error('MAGENTO_KEY is required unless --dry-run is used');
  }

  const startedAt = Date.now();

  console.log(`🚀 CAD Store ${JOB_LABEL} Price Update`);
  console.log(`🏷️  Vendor filter: ${options.vendorName}`);
  if (options.sku) {
    console.log(`🔎 SKU filter: ${options.sku}`);
  }
  console.log('🧮 Formula: USD cost decides tier (65% or 50%), markup is applied to CAD cost, then /0.85, round, -0.05');
  if (DERIVE_USD_COST_FROM_CAD) {
    console.log(`🧮 Missing USD cost fallback: vendor_cost / ${USD_TO_CAD_RATE}`);
  }
  console.log(`🧭 Price compare/update primary store_id: ${STORE_ID_CAD}`);
  console.log(`🧭 Price mirror store_id: ${STORE_ID_CAD_MIRROR}`);

  const {
    rows,
    scanned,
    skippedVendorMismatch,
    skippedMissingCost,
    skippedInvalidPrice,
    under100MarkupCount,
    over100MarkupCount,
    rowsWithFinalMargin,
    avgFinalMargin,
    minFinalMargin,
    maxFinalMargin,
    minMarginFloorAppliedCount,
    minPriceFloorAppliedCount,
  } = await getQuadratecOnlyPriceRows(options.vendorName, options.limit, options.sku);

  const {
    rows: comparedRows,
    changedRows,
    unchangedRows,
    changedPriceCount,
    unchangedPriceCount,
    unresolvedMagentoPriceCount,
    missingInMagentoCount,
    existenceUnknownCount,
    missingInMagentoSamples,
    magentoLookupFailedBatches,
    magentoLookupErrorSamples,
    comparisonSource,
  } = await classifyRowsByMagentoPrice(rows);

  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows computed: ${comparedRows.length}`);
  console.log(`🔍 Comparison source: ${comparisonSource}`);
  console.log(`🆕 Price rows changed: ${changedPriceCount}`);
  console.log(`🟰 Price rows unchanged (skipped): ${unchangedPriceCount}`);
  if (unresolvedMagentoPriceCount > 0) {
    const unresolvedTreatedAsChanged = Math.max(0, unresolvedMagentoPriceCount - missingInMagentoCount);
    console.log(`⚠️ Could not read Magento price for ${unresolvedMagentoPriceCount} SKU(s)`);
    console.log(`⚠️ Unresolved SKUs treated as changed: ${unresolvedTreatedAsChanged}`);
    const unresolvedSamples = comparedRows
      .filter((row) => row.existing_price_magento == null)
      .slice(0, 20)
      .map((row) => ({
        sku: row.sku,
        magento_price_error: row.magento_price_error || null,
      }));
    if (unresolvedSamples.length > 0) {
      console.log('⚠️ Unresolved Magento price sample SKUs:', unresolvedSamples);
    }
    if (magentoLookupFailedBatches > 0) {
      console.log(`⚠️ Magento lookup failed batches: ${magentoLookupFailedBatches}`);
      if (magentoLookupErrorSamples.length > 0) {
        console.log('⚠️ Magento lookup error samples:', magentoLookupErrorSamples);
      }
    }
  }
  if (missingInMagentoCount > 0) {
    console.log(`⚠️ Missing in Magento (excluded from updates): ${missingInMagentoCount}`);
    if (missingInMagentoSamples.length > 0) {
      console.log('⚠️ Missing in Magento sample SKUs:', missingInMagentoSamples);
    }
  }
  if (existenceUnknownCount > 0) {
    console.log(`⚠️ Magento existence unknown for ${existenceUnknownCount} SKU(s); those SKUs are still treated as changed`);
  }
  console.log(`⚠️ Skipped (vendor mismatch): ${skippedVendorMismatch}`);
  console.log(`⚠️ Skipped (missing CAD or USD cost): ${skippedMissingCost}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  console.log(`📊 Cost bucket < 100 USD (65% markup): ${under100MarkupCount}`);
  console.log(`📊 Cost bucket >= 100 USD (50% markup): ${over100MarkupCount}`);
  console.log(`🛡️ Min-margin floor applied: ${minMarginFloorAppliedCount}`);
  console.log(`🧱 Min-price floor applied (${MIN_PRICE.toFixed(2)}): ${minPriceFloorAppliedCount}`);
  console.log(`📈 Rows with final margin: ${rowsWithFinalMargin}`);
  if (rowsWithFinalMargin > 0) {
    console.log(`📈 Final margin avg/min/max: ${avgFinalMargin} / ${minFinalMargin} / ${maxFinalMargin}`);
  }

  if (comparedRows.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  if (changedRows.length === 0) {
    console.log('No price changes detected. Nothing to update.');
    if (options.dryRun && unchangedRows.length > 0) {
      console.log('Sample unchanged SKUs:', unchangedRows.slice(0, 20));
    }
    return;
  }

  if (options.dryRun) {
    console.log('🧪 Dry run mode enabled. No Magento API calls sent.');
    console.log('Sample (20) changed SKUs to update:', changedRows.slice(0, 20));
    if (unchangedRows.length > 0) {
      console.log('Sample (20) unchanged SKUs skipped:', unchangedRows.slice(0, 20));
    }
    return;
  }

  const batches = chunk(changedRows, options.batchSize);
  let sent = 0;
  let failedBatches = 0;
  const liveUpdatedSamples = [];

  for (let i = 0; i < batches.length; i++) {
    const prices = [];
    for (const row of batches[i]) {
      prices.push({
        sku: row.sku,
        store_id: STORE_ID_CAD,
        price: row.price,
      });

      if (
        Number.isInteger(STORE_ID_CAD_MIRROR)
        && STORE_ID_CAD_MIRROR >= 0
        && STORE_ID_CAD_MIRROR !== STORE_ID_CAD
      ) {
        prices.push({
          sku: row.sku,
          store_id: STORE_ID_CAD_MIRROR,
          price: row.price,
        });
      }
    }

    try {
      const response = await postBasePricesBatch(prices);
      sent += prices.length;

      if (liveUpdatedSamples.length < 20) {
        const needed = 20 - liveUpdatedSamples.length;
        liveUpdatedSamples.push(...prices.slice(0, needed));
      }

      console.log(
        `✅ Batch ${i + 1}/${batches.length} sent (${prices.length} SKUs) | HTTP ${response.status}`
      );
    } catch (error) {
      failedBatches++;
      const status = error.response?.status || 'ERR';
      const details = JSON.stringify(error.response?.data || error.message).slice(0, 400);
      console.log(`❌ Batch ${i + 1}/${batches.length} failed | ${status} ${details}`);
    }

    if (i + 1 < batches.length && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n✅ Job complete');
  console.log(`   - Total computed: ${comparedRows.length}`);
  console.log(`   - Total changed: ${changedRows.length}`);
  console.log(`   - Total unchanged skipped: ${unchangedRows.length}`);
  console.log(`   - Total sent: ${sent}`);
  console.log(`   - Failed batches: ${failedBatches}`);
  console.log(`   - Elapsed: ${elapsedSeconds}s`);

  if (liveUpdatedSamples.length > 0) {
    console.log('   - Sample (20) updated SKUs:', liveUpdatedSamples);
  }

  if (failedBatches > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('❌ Fatal error:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });