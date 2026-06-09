#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');

dotenv.config();

const TERAFLEX_BRAND_MATCH = 'teraflex';
const STORE_ID_CAD = Number(process.env.CAD_STORE_ID || 0);
const STORE_ID_CAD_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);
const FAKE_PROMO_MULTIPLIER = 0.85;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function parseArgs(argv) {
  const options = {
    sku: null,
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
    alignAllMismatch: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--sku' && argv[i + 1]) {
      options.sku = String(argv[++i]).trim();
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--batch-size' && argv[i + 1]) {
      options.batchSize = Number(argv[++i]);
    } else if (arg === '--delay-ms' && argv[i + 1]) {
      options.delayMs = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--align-all-mismatch') {
      options.alignAllMismatch = true;
    }
  }

  return options;
}

function isSamePrice(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.00001;
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

function mapRelation(currentLivePrice, sourceMapPrice) {
  if (!Number.isFinite(currentLivePrice) || !Number.isFinite(sourceMapPrice)) return 'unknown';
  if (isSamePrice(currentLivePrice, sourceMapPrice)) return 'at_map';
  return currentLivePrice < sourceMapPrice ? 'below_map' : 'above_map';
}

async function getTeraflexMapRows({ limit, sku }) {
  const skuFilter = String(sku || '').trim();

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      brand_name: {
        contains: TERAFLEX_BRAND_MATCH,
        mode: 'insensitive',
      },
      MAP: {
        gt: 0,
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
      searchable_sku: true,
      brand_name: true,
      price: true,
      MAP: true,
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  for (const product of products) {
    const sourceMapPrice = Number(product.MAP);
    const cadPrice = toCadSitePriceFromMap(sourceMapPrice);
    if (!Number.isFinite(cadPrice) || cadPrice <= 0) {
      continue;
    }

    const currentLivePrice = toEffectiveLivePrice(product.price);

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_CAD,
      brand_name: product.brand_name,
      searchable_sku: product.searchable_sku,
      existing_price_db: product.price,
      existing_effective_price: currentLivePrice,
      current_live_price_after_discount: currentLivePrice,
      source_map_price: sourceMapPrice,
      new_price: cadPrice,
      price_after_discount: toEffectiveLivePrice(cadPrice),
      map_gap: computeMapGap(currentLivePrice, sourceMapPrice),
      map_relation: mapRelation(currentLivePrice, sourceMapPrice),
      map_source: 'product.MAP',
    });
  }

  return {
    rows,
    scanned: products.length,
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

async function classifyRowsByMagentoPrice(rows, { alignAllMismatch }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      rows: [],
      changedRows: [],
      unchangedRows: [],
      changedPriceCount: 0,
      unchangedPriceCount: 0,
      belowMapCount: 0,
      atMapCount: 0,
      aboveMapCount: 0,
      comparisonSource: 'none',
      unresolvedMagentoPriceCount: 0,
      magentoLookupFailedBatches: 0,
      magentoLookupErrorSamples: [],
    };
  }

  if (!MAGENTO_CONFIG.token) {
    const fallbackRows = rows.map((row) => {
      const current = toEffectiveLivePrice(row.existing_price_db);
      const relation = mapRelation(current, row.source_map_price);
      const shouldUpdate = alignAllMismatch ? relation !== 'at_map' : relation === 'below_map';

      return {
        ...row,
        existing_price_magento: null,
        current_live_price_after_discount: current,
        map_gap: computeMapGap(current, row.source_map_price),
        map_relation: relation,
        price_changed: shouldUpdate,
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
      belowMapCount: fallbackRows.filter((row) => row.map_relation === 'below_map').length,
      atMapCount: fallbackRows.filter((row) => row.map_relation === 'at_map').length,
      aboveMapCount: fallbackRows.filter((row) => row.map_relation === 'above_map').length,
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

      const current = Number.isFinite(magentoPrice)
        ? toEffectiveLivePrice(magentoPrice)
        : toEffectiveLivePrice(row.existing_price_db);

      row.current_live_price_after_discount = current;
      row.map_gap = computeMapGap(current, row.source_map_price);
      row.map_relation = mapRelation(current, row.source_map_price);
      row.existing_effective_price = current;
      row.price_changed = alignAllMismatch
        ? row.map_relation !== 'at_map'
        : row.map_relation === 'below_map';

      if (!Number.isFinite(magentoPrice)) {
        unresolvedMagentoPriceCount++;
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
      belowMapCount: outRows.filter((row) => row.map_relation === 'below_map').length,
      atMapCount: outRows.filter((row) => row.map_relation === 'at_map').length,
      aboveMapCount: outRows.filter((row) => row.map_relation === 'above_map').length,
      comparisonSource: failedBatches > 0 ? 'magento-partial' : 'magento',
      unresolvedMagentoPriceCount,
      magentoLookupFailedBatches: failedBatches,
      magentoLookupErrorSamples: errorSamples,
    };
  } catch (error) {
    for (const row of outRows) {
      const current = toEffectiveLivePrice(row.existing_price_db);
      row.price_changed = alignAllMismatch
        ? mapRelation(current, row.source_map_price) !== 'at_map'
        : mapRelation(current, row.source_map_price) === 'below_map';
      row.current_live_price_after_discount = current;
      row.map_gap = computeMapGap(current, row.source_map_price);
      row.map_relation = mapRelation(current, row.source_map_price);
      row.magento_price_error = String(error.response?.data?.message || error.message || 'unknown').slice(0, 160);
    }

    const changedRows = outRows.filter((row) => row.price_changed);
    const unchangedRows = outRows.filter((row) => !row.price_changed);

    return {
      rows: outRows,
      changedRows,
      unchangedRows,
      changedPriceCount: changedRows.length,
      unchangedPriceCount: unchangedRows.length,
      belowMapCount: outRows.filter((row) => row.map_relation === 'below_map').length,
      atMapCount: outRows.filter((row) => row.map_relation === 'at_map').length,
      aboveMapCount: outRows.filter((row) => row.map_relation === 'above_map').length,
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
  console.log('Check and fix TeraFlex CAD prices against Product.MAP.');
  console.log('MAP source behavior:');
  console.log('  - Uses product.brand_name contains teraflex and product.MAP > 0');
  console.log(`  - CAD base price is derived as MAP / ${FAKE_PROMO_MULTIPLIER} (so discounted price aligns to MAP)`);
  console.log('  - Base price is rounded up to .95 ending using ceil(value + 0.05) - 0.05');
  console.log('  - Default update behavior: fix only SKUs below MAP');
  console.log('  - Optional behavior with --align-all-mismatch: align any SKU not exactly at MAP');
  console.log(`  - Primary store ID updated/compared: ${STORE_ID_CAD}`);
  console.log(`  - Mirror store ID also updated: ${STORE_ID_CAD_MIRROR}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/cad_store/update-teraflex-map-cad-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --sku <sku>               Restrict run to one SKU');
  console.log('  --limit <number>          Limit products fetched from DB');
  console.log('  --batch-size <number>     Prices per Magento request (default: 1000)');
  console.log('  --delay-ms <number>       Delay between batches in milliseconds (default: 400)');
  console.log('  --align-all-mismatch      Update SKUs above or below MAP (not just below)');
  console.log('  --dry-run                 Print sample payload only, do not send updates');
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

  console.log('CAD Store TeraFlex MAP Alignment');
  console.log(`Brand filter: product.brand_name contains "${TERAFLEX_BRAND_MATCH}"`);
  console.log('MAP source: product.MAP');
  console.log(`CAD formula: (MAP / ${FAKE_PROMO_MULTIPLIER}) then ceil(value + 0.05) - 0.05`);
  console.log(`Price compare/update primary store_id: ${STORE_ID_CAD}`);
  console.log(`Price mirror store_id: ${STORE_ID_CAD_MIRROR}`);
  console.log(`Update mode: ${options.alignAllMismatch ? 'all MAP mismatches' : 'below MAP only'}`);

  const {
    rows,
    scanned,
  } = await getTeraflexMapRows({
    limit: options.limit,
    sku: options.sku,
  });

  const {
    rows: comparedRows,
    changedRows,
    unchangedRows,
    changedPriceCount,
    unchangedPriceCount,
    belowMapCount,
    atMapCount,
    aboveMapCount,
    comparisonSource,
    unresolvedMagentoPriceCount,
    magentoLookupFailedBatches,
    magentoLookupErrorSamples,
  } = await classifyRowsByMagentoPrice(rows, {
    alignAllMismatch: options.alignAllMismatch,
  });

  console.log(`TeraFlex products scanned (MAP > 0): ${scanned}`);
  console.log(`Price rows computed: ${comparedRows.length}`);
  console.log(`Comparison source: ${comparisonSource}`);
  console.log(`Below MAP: ${belowMapCount} | At MAP: ${atMapCount} | Above MAP: ${aboveMapCount}`);
  console.log(`Price rows changed: ${changedPriceCount}`);
  console.log(`Price rows unchanged (skipped): ${unchangedPriceCount}`);

  if (unresolvedMagentoPriceCount > 0) {
    console.log(`Could not read Magento price for ${unresolvedMagentoPriceCount} SKU(s); DB price fallback used for MAP comparison`);
    const unresolvedSamples = comparedRows
      .filter((row) => row.existing_price_magento == null)
      .slice(0, 20)
      .map((row) => ({ sku: row.sku, magento_price_error: row.magento_price_error || null }));
    if (unresolvedSamples.length > 0) {
      console.log('Unresolved Magento price sample SKUs:', unresolvedSamples);
    }
  }

  if (magentoLookupFailedBatches > 0) {
    console.log(`Magento lookup failed batches: ${magentoLookupFailedBatches}`);
    if (magentoLookupErrorSamples.length > 0) {
      console.log('Magento lookup error samples:', magentoLookupErrorSamples);
    }
  }

  if (comparedRows.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  if (changedRows.length === 0) {
    console.log('No MAP-price violations matched the selected mode. Nothing to update.');
    if (options.dryRun && unchangedRows.length > 0) {
      console.log('Sample unchanged SKUs:', unchangedRows.slice(0, 20));
    }
    return;
  }

  if (options.dryRun) {
    console.log('Dry run mode enabled. No Magento API calls sent.');
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

      console.log(`Batch ${i + 1}/${batches.length} sent (${prices.length} rows) | HTTP ${response.status}`);
    } catch (error) {
      failedBatches++;
      const status = error.response?.status || 'ERR';
      const details = JSON.stringify(error.response?.data || error.message).slice(0, 400);
      console.log(`Batch ${i + 1}/${batches.length} failed | ${status} ${details}`);
    }

    if (i + 1 < batches.length && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\nJob complete');
  console.log(`  - Total computed: ${comparedRows.length}`);
  console.log(`  - Total changed: ${changedRows.length}`);
  console.log(`  - Total unchanged skipped: ${unchangedRows.length}`);
  console.log(`  - Total sent: ${sent}`);
  console.log(`  - Failed batches: ${failedBatches}`);
  console.log(`  - Elapsed: ${elapsedSeconds}s`);
  if (liveUpdatedSamples.length > 0) {
    console.log('  - Sample (20) updated SKUs:', liveUpdatedSamples);
  }

  if (failedBatches > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
