#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../../lib/prisma');

dotenv.config();

const VENDOR_ID_ALPINE = 13;
const JJ_PREFIX_ALPINE = 'ALP';
const STORE_ID_CAD = Number(process.env.CAD_STORE_ID || 0);
const STORE_ID_CAD_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);
const FAKE_PROMO_MULTIPLIER = 0.85;
const DEFAULT_MAP_FILE = path.join(__dirname, '../../prisma/seeds/api-calls/Alpine Promo Calendar Canada MAP.xlsx');

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function parseArgs(argv) {
  const options = {
    file: DEFAULT_MAP_FILE,
    sku: null,
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--file' && argv[i + 1]) {
      options.file = String(argv[++i]).trim();
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

function isSamePrice(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.00001;
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return Number(asNumber.toFixed(2));
  }

  const cleaned = String(value)
    .replace(/[$,]/g, '')
    .trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(2));
}

function toDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function excelSerialToDate(value) {
  if (!Number.isFinite(Number(value))) return null;
  const parsed = XLSX.SSF.parse_date_code(Number(value));
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
}

function normalizeModel(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function formatDateISO(date) {
  if (!(date instanceof Date)) return null;
  return date.toISOString().slice(0, 10);
}

function roundToPoint95(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number((Math.ceil(numeric + 0.05) - 0.05).toFixed(2));
}

function toCadSitePriceFromMap(mapPrice) {
  const map = Number(mapPrice);
  if (!Number.isFinite(map) || map <= 0) return null;
  const basePriceBeforeDiscount = map / FAKE_PROMO_MULTIPLIER;
  return roundToPoint95(basePriceBeforeDiscount);
}

function toEffectiveLivePrice(basePrice) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base <= 0) return null;
  return Number((base * FAKE_PROMO_MULTIPLIER).toFixed(2));
}

function findCalendarColumns(rows) {
  const startsRow = rows[1] || {};
  const endsRow = rows[2] || {};

  const columns = [];
  for (const key of Object.keys(startsRow)) {
    const startDate = excelSerialToDate(startsRow[key]);
    const endDate = excelSerialToDate(endsRow[key]);
    if (!startDate || !endDate) continue;
    columns.push({ key, startDate, endDate });
  }

  columns.sort((a, b) => a.startDate - b.startDate);
  return columns;
}

function pickActiveCalendarColumn(columns, nowDate = new Date()) {
  if (!Array.isArray(columns) || columns.length === 0) return null;

  const today = toDateOnly(nowDate);
  const active = columns.find((col) => col.startDate <= today && today <= col.endDate);
  if (active) return active;

  const latestPast = columns
    .filter((col) => col.endDate <= today)
    .sort((a, b) => b.endDate - a.endDate)[0];
  if (latestPast) return latestPast;

  return columns[0];
}

function extractAlpineMapByModel(filePath, nowDate = new Date()) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

  const columns = findCalendarColumns(rows);
  if (columns.length === 0) {
    throw new Error('Could not detect calendar date columns in Alpine MAP workbook');
  }

  const activeColumn = pickActiveCalendarColumn(columns, nowDate);
  const dataRows = rows.slice(3);

  const mapRowsByModel = new Map();
  const promoMapRowsByModel = new Map();
  let ignoredRows = 0;

  for (const row of dataRows) {
    const model = String(row.__EMPTY_1 || '').trim();
    const priceType = String(row.__EMPTY_2 || '').trim().toLowerCase();
    if (!model) {
      ignoredRows++;
      continue;
    }

    const mapValue = parseMoney(row[activeColumn.key]);
    if (priceType === 'map') {
      mapRowsByModel.set(normalizeModel(model), {
        model,
        value: mapValue,
      });
    } else if (priceType === 'promo map') {
      promoMapRowsByModel.set(normalizeModel(model), {
        model,
        value: mapValue,
      });
    }
  }

  const effectiveMapByModel = new Map();
  let promoOverrideCount = 0;

  for (const [modelKey, mapRow] of mapRowsByModel.entries()) {
    const promoRow = promoMapRowsByModel.get(modelKey);
    const promoValue = promoRow?.value;
    const mapValue = mapRow?.value;

    if (Number.isFinite(promoValue) && promoValue > 0) {
      effectiveMapByModel.set(modelKey, {
        model: mapRow.model,
        effectiveMap: promoValue,
        source: 'promo_map',
      });
      promoOverrideCount++;
      continue;
    }

    if (Number.isFinite(mapValue) && mapValue > 0) {
      effectiveMapByModel.set(modelKey, {
        model: mapRow.model,
        effectiveMap: mapValue,
        source: 'map',
      });
    }
  }

  return {
    workbookSheet: firstSheet,
    calendarColumnKey: activeColumn.key,
    calendarStartDate: activeColumn.startDate,
    calendarEndDate: activeColumn.endDate,
    effectiveMapByModel,
    totalMapRows: mapRowsByModel.size,
    totalPromoRows: promoMapRowsByModel.size,
    promoOverrideCount,
    ignoredRows,
  };
}

function getModelCandidates(product) {
  const candidates = [];

  const vendorSku = String(product.vendorProducts?.[0]?.vendor_sku || '').trim();
  const searchable = String(product.searchable_sku || '').trim();
  const sku = String(product.sku || '').trim();
  const skuWithoutPrefix = sku.replace(/^ALP[-_]?/i, '').trim();

  for (const value of [vendorSku, searchable, sku, skuWithoutPrefix]) {
    const normalized = normalizeModel(value);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  return Array.from(new Set(candidates));
}

async function getAlpineMapRows({ effectiveMapByModel, limit, sku }) {
  const skuFilter = String(sku || '').trim();

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      jj_prefix: JJ_PREFIX_ALPINE,
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
      searchable_sku: true,
      price: true,
      vendorProducts: {
        where: { vendor_id: VENDOR_ID_ALPINE },
        select: { vendor_sku: true },
        take: 1,
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  let matchedCount = 0;
  let unmatchedCount = 0;
  const unmatchedSamples = [];

  for (const product of products) {
    const candidates = getModelCandidates(product);

    let matched = null;
    for (const key of candidates) {
      const found = effectiveMapByModel.get(key);
      if (found) {
        matched = found;
        break;
      }
    }

    if (!matched) {
      unmatchedCount++;
      if (unmatchedSamples.length < 30) {
        unmatchedSamples.push({
          sku: product.sku,
          searchable_sku: product.searchable_sku,
          vendor_sku: product.vendorProducts?.[0]?.vendor_sku || null,
          tried_keys: candidates,
        });
      }
      continue;
    }

    matchedCount++;
    const cadPrice = toCadSitePriceFromMap(matched.effectiveMap);
    if (!Number.isFinite(cadPrice) || cadPrice <= 0) {
      unmatchedCount++;
      continue;
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_CAD,
      existing_price_db: product.price,
      existing_effective_price: toEffectiveLivePrice(product.price),
      source_map_price: matched.effectiveMap,
      new_price: cadPrice,
      price_after_discount: toEffectiveLivePrice(cadPrice),
      alpine_model: matched.model,
      map_source: matched.source,
    });
  }

  return {
    rows,
    scanned: products.length,
    matchedCount,
    unmatchedCount,
    unmatchedSamples,
  };
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function fetchMagentoBasePricesBySkus(skus) {
  const uniqueSkus = Array.from(new Set((skus || []).map((v) => String(v || '').trim()).filter(Boolean)));
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

  const lookupBatches = chunk(uniqueSkus, 500);
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
      for (const value of batch) {
        failedSkuSet.add(value);
      }

      if (errorSamples.length < 5) {
        errorSamples.push({
          status: error.response?.status || 'ERR',
          details: String(error.response?.data?.message || error.message || 'unknown').slice(0, 180),
          batch_size: batch.length,
        });
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

async function classifyRowsByMagentoPrice(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      rows: [],
      changedRows: [],
      unchangedRows: [],
      changedPriceCount: 0,
      unchangedPriceCount: 0,
      comparisonSource: 'none',
      unresolvedMagentoPriceCount: 0,
      magentoLookupFailedBatches: 0,
      magentoLookupErrorSamples: [],
    };
  }

  if (!MAGENTO_CONFIG.token) {
    const fallbackRows = rows.map((row) => ({
      ...row,
      existing_price_magento: null,
      price_changed: !Number.isFinite(Number(toEffectiveLivePrice(row.existing_price_db)))
        ? true
        : !isSamePrice(toEffectiveLivePrice(row.existing_price_db), row.source_map_price),
    }));

    const changedRows = fallbackRows.filter((row) => row.price_changed);
    const unchangedRows = fallbackRows.filter((row) => !row.price_changed);
    return {
      rows: fallbackRows,
      changedRows,
      unchangedRows,
      changedPriceCount: changedRows.length,
      unchangedPriceCount: unchangedRows.length,
      comparisonSource: 'db-fallback',
      unresolvedMagentoPriceCount: fallbackRows.length,
      magentoLookupFailedBatches: 0,
      magentoLookupErrorSamples: [],
    };
  }

  const outRows = rows.map((row) => ({
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
      const byStore = bySku.get(row.sku);
      const magentoPrice = byStore?.get(STORE_ID_CAD);
      row.existing_price_magento = Number.isFinite(magentoPrice) ? magentoPrice : null;
      row.existing_effective_price = toEffectiveLivePrice(row.existing_price_magento);

      if (Number.isFinite(magentoPrice)) {
        row.price_changed = !isSamePrice(row.existing_effective_price, row.source_map_price);
      } else {
        unresolvedMagentoPriceCount++;
        row.price_changed = true;
        if (failedSkuSet.has(row.sku)) {
          row.magento_price_error = 'base-prices-information lookup batch failed';
        }
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
      comparisonSource: failedBatches > 0 ? 'magento-partial' : 'magento',
      unresolvedMagentoPriceCount,
      magentoLookupFailedBatches: failedBatches,
      magentoLookupErrorSamples: errorSamples,
    };
  } catch (error) {
    for (const row of outRows) {
      row.price_changed = true;
      row.magento_price_error = String(error.response?.data?.message || error.message || 'unknown').slice(0, 160);
    }

    const changedRows = outRows.filter((row) => row.price_changed);
    return {
      rows: outRows,
      changedRows,
      unchangedRows: [],
      changedPriceCount: changedRows.length,
      unchangedPriceCount: 0,
      comparisonSource: 'magento-failed',
      unresolvedMagentoPriceCount: outRows.length,
      magentoLookupFailedBatches: 1,
      magentoLookupErrorSamples: [{
        status: error.response?.status || 'ERR',
        details: String(error.response?.data?.message || error.message || 'unknown').slice(0, 180),
        batch_size: outRows.length,
      }],
    };
  }
}

async function postBasePricesBatch(prices) {
  return axios.post(
    `${MAGENTO_CONFIG.baseURL}/products/base-prices`,
    { prices },
    {
      headers: {
        Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      maxBodyLength: Infinity,
      timeout: MAGENTO_CONFIG.timeout,
    }
  );
}

function printUsage() {
  console.log('Align Alpine CAD prices to MAP from Alpine Promo Calendar Canada workbook.');
  console.log('MAP source behavior:');
  console.log('  - Uses active date window from workbook (or latest past window if today is not in-range)');
  console.log('  - Effective price is Promo MAP when present, otherwise MAP');
  console.log(`  - CAD base price is derived as MAP / ${FAKE_PROMO_MULTIPLIER} (so discounted price aligns to MAP)`);
  console.log('  - Base price is rounded up to .95 ending using ceil(value + 0.05) - 0.05');
  console.log(`  - Primary store ID updated/compared: ${STORE_ID_CAD}`);
  console.log(`  - Mirror store ID also updated: ${STORE_ID_CAD_MIRROR}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/cad_store/update-alpine-map-cad-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --file <path>           Workbook path (default: ${DEFAULT_MAP_FILE})`);
  console.log('  --sku <sku>             Restrict run to one SKU');
  console.log('  --limit <number>        Limit products fetched from DB');
  console.log('  --batch-size <number>   Prices per Magento request (default: 1000)');
  console.log('  --delay-ms <number>     Delay between batches in milliseconds (default: 400)');
  console.log('  --dry-run               Print sample payload only, do not send updates');
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
  const now = new Date();

  const mapData = extractAlpineMapByModel(options.file, now);
  const {
    workbookSheet,
    calendarStartDate,
    calendarEndDate,
    effectiveMapByModel,
    totalMapRows,
    totalPromoRows,
    promoOverrideCount,
  } = mapData;

  console.log('🚀 CAD Store Alpine MAP Alignment');
  console.log(`📄 Workbook: ${options.file}`);
  console.log(`📋 Sheet: ${workbookSheet}`);
  console.log(`📅 Effective calendar window: ${formatDateISO(calendarStartDate)} -> ${formatDateISO(calendarEndDate)}`);
  console.log(`🧮 MAP rows: ${totalMapRows} | Promo MAP rows: ${totalPromoRows} | Promo overrides used: ${promoOverrideCount}`);
  console.log(`🧮 CAD formula: (MAP / ${FAKE_PROMO_MULTIPLIER}) then ceil(value + 0.05) - 0.05`);
  console.log(`🎯 Models with effective MAP: ${effectiveMapByModel.size}`);
  console.log(`🧭 Price compare/update primary store_id: ${STORE_ID_CAD}`);
  console.log(`🧭 Price mirror store_id: ${STORE_ID_CAD_MIRROR}`);

  const {
    rows,
    scanned,
    matchedCount,
    unmatchedCount,
    unmatchedSamples,
  } = await getAlpineMapRows({
    effectiveMapByModel,
    limit: options.limit,
    sku: options.sku,
  });

  const {
    rows: comparedRows,
    changedRows,
    unchangedRows,
    changedPriceCount,
    unchangedPriceCount,
    comparisonSource,
    unresolvedMagentoPriceCount,
    magentoLookupFailedBatches,
    magentoLookupErrorSamples,
  } = await classifyRowsByMagentoPrice(rows);

  console.log(`📦 Alpine products scanned: ${scanned}`);
  console.log(`✅ Alpine products matched to MAP model: ${matchedCount}`);
  console.log(`⚠️ Alpine products without MAP match: ${unmatchedCount}`);
  if (unmatchedSamples.length > 0) {
    console.log('⚠️ Unmatched Alpine SKU samples:', unmatchedSamples);
  }

  console.log(`✅ Price rows computed: ${comparedRows.length}`);
  console.log(`🔍 Comparison source: ${comparisonSource}`);
  console.log(`🆕 Price rows changed: ${changedPriceCount}`);
  console.log(`🟰 Price rows unchanged (skipped): ${unchangedPriceCount}`);
  if (unresolvedMagentoPriceCount > 0) {
    console.log(`⚠️ Could not read Magento price for ${unresolvedMagentoPriceCount} SKU(s); unresolved SKUs are treated as changed`);
    const unresolvedSamples = comparedRows
      .filter((row) => row.existing_price_magento == null)
      .slice(0, 20)
      .map((row) => ({ sku: row.sku, magento_price_error: row.magento_price_error || null }));
    if (unresolvedSamples.length > 0) {
      console.log('⚠️ Unresolved Magento price sample SKUs:', unresolvedSamples);
    }
  }
  if (magentoLookupFailedBatches > 0) {
    console.log(`⚠️ Magento lookup failed batches: ${magentoLookupFailedBatches}`);
    if (magentoLookupErrorSamples.length > 0) {
      console.log('⚠️ Magento lookup error samples:', magentoLookupErrorSamples);
    }
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
        price: row.new_price,
      });

      if (
        Number.isInteger(STORE_ID_CAD_MIRROR)
        && STORE_ID_CAD_MIRROR >= 0
        && STORE_ID_CAD_MIRROR !== STORE_ID_CAD
      ) {
        prices.push({
          sku: row.sku,
          store_id: STORE_ID_CAD_MIRROR,
          price: row.new_price,
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

      console.log(`✅ Batch ${i + 1}/${batches.length} sent (${prices.length} rows) | HTTP ${response.status}`);
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
