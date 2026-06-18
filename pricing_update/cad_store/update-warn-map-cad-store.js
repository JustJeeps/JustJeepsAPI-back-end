#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../../lib/prisma');

dotenv.config();

const JJ_PREFIX_WARN = 'WAR';
const STORE_ID_CAD = Number(process.env.CAD_STORE_ID || 0);
const STORE_ID_CAD_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);
const FAKE_PROMO_MULTIPLIER = 0.85;
const DEFAULT_MAP_FILE = path.join(__dirname, '../../prisma/seeds/api-calls/WARN-MAP.xlsx');

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

function normalizeWarnPart(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function extractWarnPartTokens(rawPart) {
  const raw = String(rawPart || '').trim();
  if (!raw) return [];

  const splitTokens = raw
    .split(/[\r\n,;/|\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const unique = new Set();
  for (const token of splitTokens) {
    const normalized = normalizeWarnPart(token);
    if (normalized) unique.add(normalized);
  }

  if (unique.size === 0) {
    const fallback = normalizeWarnPart(raw);
    if (fallback) unique.add(fallback);
  }

  return Array.from(unique);
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

function computeMapGap(currentLivePrice, sourceMapPrice) {
  const current = Number(currentLivePrice);
  const map = Number(sourceMapPrice);
  if (!Number.isFinite(current) || !Number.isFinite(map)) return null;
  return Number((current - map).toFixed(2));
}

function findColumnIndex(headerRow, matcher) {
  for (let i = 0; i < headerRow.length; i++) {
    if (matcher(headerRow[i])) return i;
  }
  return -1;
}

function extractWarnMapByPart(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  let headerIndex = -1;
  let partColumn = -1;
  let mapColumn = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const detectedPartColumn = findColumnIndex(row, (value) => {
      const text = String(value || '').toLowerCase().replace(/\s+/g, ' ');
      return text.includes('warn part number');
    });
    const detectedMapColumn = findColumnIndex(row, (value) => {
      const text = String(value || '').toLowerCase().replace(/\s+/g, ' ');
      return text.includes('retailer to') && text.includes('consumer');
    });

    if (detectedPartColumn >= 0 && detectedMapColumn >= 0) {
      headerIndex = i;
      partColumn = detectedPartColumn;
      mapColumn = detectedMapColumn;
      break;
    }
  }

  if (headerIndex < 0 || partColumn < 0 || mapColumn < 0) {
    throw new Error('Could not locate WARN Part Number and Retailer to Consumer columns in workbook');
  }

  const mapByPart = new Map();
  let ignoredRows = 0;

  const consumedContinuationRows = new Set();

  for (let i = headerIndex + 1; i < rows.length; i++) {
    if (consumedContinuationRows.has(i)) {
      continue;
    }

    const row = rows[i] || [];
    const rawPart = row[partColumn];
    const mapValue = parseMoney(row[mapColumn]);
    const partNumber = String(rawPart || '').trim();
    const normalizedParts = extractWarnPartTokens(partNumber);

    if (normalizedParts.length === 0) {
      ignoredRows++;
      continue;
    }

    const mapPrices = [];
    if (Number.isFinite(mapValue) && mapValue > 0) {
      mapPrices.push(mapValue);
    }

    if (normalizedParts.length > 1) {
      let lookahead = i + 1;
      while (mapPrices.length < normalizedParts.length && lookahead < rows.length) {
        const nextRow = rows[lookahead] || [];
        const nextPartTokens = extractWarnPartTokens(nextRow[partColumn]);
        if (nextPartTokens.length > 0) {
          break;
        }

        const nextMapValue = parseMoney(nextRow[mapColumn]);
        if (!Number.isFinite(nextMapValue) || nextMapValue <= 0) {
          break;
        }

        mapPrices.push(nextMapValue);
        consumedContinuationRows.add(lookahead);
        lookahead++;
      }
    }

    if (mapPrices.length === 0) {
      ignoredRows++;
      continue;
    }

    const hasPerPartMapValues = mapPrices.length === normalizedParts.length;
    for (let partIndex = 0; partIndex < normalizedParts.length; partIndex++) {
      const normalizedPart = normalizedParts[partIndex];
      const mapPrice = hasPerPartMapValues ? mapPrices[partIndex] : mapPrices[0];
      const sourcePartNumber = hasPerPartMapValues
        ? normalizedPart
        : partNumber;

      mapByPart.set(normalizedPart, {
        partNumber: sourcePartNumber,
        mapPrice,
      });
    }
  }

  return {
    workbookSheet: firstSheet,
    headerRowNumber: headerIndex + 1,
    partColumnNumber: partColumn + 1,
    mapColumnNumber: mapColumn + 1,
    mapByPart,
    ignoredRows,
  };
}

function getWarnPartCandidates(product) {
  const candidateSet = new Set();

  const vendorSkus = Array.isArray(product.vendorProducts)
    ? product.vendorProducts.map((row) => String(row?.vendor_sku || '').trim()).filter(Boolean)
    : [];
  const searchable = String(product.searchable_sku || '').trim();
  const sku = String(product.sku || '').trim();
  const skuWithoutPrefix = sku.replace(/^WAR[-_]?/i, '').trim();

  const values = [...vendorSkus, searchable, sku, skuWithoutPrefix];

  for (const value of values) {
    if (!value) continue;

    const normalized = normalizeWarnPart(value);
    if (normalized) {
      candidateSet.add(normalized);
    }

    const stripped = normalizeWarnPart(value.replace(/^WAR[-_]?/i, ''));
    if (stripped) {
      candidateSet.add(stripped);
    }

    const digitMatches = value.match(/\d{4,}/g) || [];
    for (const digits of digitMatches) {
      const key = normalizeWarnPart(digits);
      if (key) {
        candidateSet.add(key);
      }
    }
  }

  return Array.from(candidateSet);
}

async function getWarnMapRows({ mapByPart, limit, sku }) {
  const skuFilter = String(sku || '').trim();

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      jj_prefix: JJ_PREFIX_WARN,
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
        select: { vendor_sku: true },
        take: 10,
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
    const candidates = getWarnPartCandidates(product);

    let matched = null;
    for (const key of candidates) {
      const found = mapByPart.get(key);
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
    const cadPrice = toCadSitePriceFromMap(matched.mapPrice);
    if (!Number.isFinite(cadPrice) || cadPrice <= 0) {
      unmatchedCount++;
      continue;
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_CAD,
      existing_price_db: product.price,
      existing_effective_price: toEffectiveLivePrice(product.price),
      current_live_price_after_discount: toEffectiveLivePrice(product.price),
      source_map_price: matched.mapPrice,
      new_price: cadPrice,
      price_after_discount: toEffectiveLivePrice(cadPrice),
      warn_part_number: matched.partNumber,
      map_source: 'retailer_to_consumer',
      map_gap: computeMapGap(toEffectiveLivePrice(product.price), matched.mapPrice),
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
      current_live_price_after_discount: toEffectiveLivePrice(row.existing_price_db),
      map_gap: computeMapGap(toEffectiveLivePrice(row.existing_price_db), row.source_map_price),
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
      row.current_live_price_after_discount = row.existing_effective_price;
      row.map_gap = computeMapGap(row.current_live_price_after_discount, row.source_map_price);

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
  console.log('Align WARN CAD prices to MAP from WARN-MAP workbook.');
  console.log('MAP source behavior:');
  console.log('  - Uses WARN Part Number to match products (from SKU/searchable/vendor SKU candidates)');
  console.log('  - Uses Retailer to Consumer as source MAP');
  console.log(`  - CAD base price is derived as MAP / ${FAKE_PROMO_MULTIPLIER} (so discounted price aligns to MAP)`);
  console.log('  - Base price is rounded up to .95 ending using ceil(value + 0.05) - 0.05');
  console.log(`  - Primary store ID updated/compared: ${STORE_ID_CAD}`);
  console.log(`  - Mirror store ID also updated: ${STORE_ID_CAD_MIRROR}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/cad_store/update-warn-map-cad-store.js [options]');
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

  const mapData = extractWarnMapByPart(options.file);
  const {
    workbookSheet,
    headerRowNumber,
    partColumnNumber,
    mapColumnNumber,
    mapByPart,
    ignoredRows,
  } = mapData;

  console.log('🚀 CAD Store WARN MAP Alignment');
  console.log(`📄 Workbook: ${options.file}`);
  console.log(`📋 Sheet: ${workbookSheet}`);
  console.log(`📍 Header row: ${headerRowNumber} | WARN Part Number col: ${partColumnNumber} | Retailer to Consumer col: ${mapColumnNumber}`);
  console.log(`🧮 CAD formula: (MAP / ${FAKE_PROMO_MULTIPLIER}) then ceil(value + 0.05) - 0.05`);
  console.log(`🎯 WARN parts with MAP: ${mapByPart.size}`);
  console.log(`🧹 Ignored workbook rows: ${ignoredRows}`);
  console.log(`🧭 Price compare/update primary store_id: ${STORE_ID_CAD}`);
  console.log(`🧭 Price mirror store_id: ${STORE_ID_CAD_MIRROR}`);

  const {
    rows,
    scanned,
    matchedCount,
    unmatchedCount,
    unmatchedSamples,
  } = await getWarnMapRows({
    mapByPart,
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

  console.log(`📦 WARN products scanned (jj_prefix=${JJ_PREFIX_WARN}): ${scanned}`);
  console.log(`✅ WARN products matched to MAP part: ${matchedCount}`);
  console.log(`⚠️ WARN products without MAP match: ${unmatchedCount}`);
  if (unmatchedSamples.length > 0) {
    console.log('⚠️ Unmatched WARN SKU samples:', unmatchedSamples);
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
