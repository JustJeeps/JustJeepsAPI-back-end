#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const roughCountryFeed = require('../../prisma/seeds/api-calls/roughCountry-excel');

dotenv.config();

const STORE_ID_US = 2;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalize(value) {
  return (value || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const options = {
    brandName: 'Rough Country',
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if ((arg === '--brand' || arg === '--vendor') && argv[i + 1]) {
      options.brandName = argv[++i];
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

function roundUpToPoint95(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Number((Math.ceil(numericValue + 0.05) - 0.05).toFixed(2));
}

function toUsStorePrice(vendorRetailPriceUsd) {
  const retailUsd = Number(vendorRetailPriceUsd);
  if (!Number.isFinite(retailUsd) || retailUsd <= 0) return null;

  const targetBasePrice = retailUsd / 0.85;
  return roundUpToPoint95(targetBasePrice);
}

function calculateFinalMargin(price, costUsd) {
  const computedPrice = Number(price);
  const cost = Number(costUsd);

  if (!Number.isFinite(computedPrice) || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  const margin = ((computedPrice * 0.85) - cost) / cost;
  return Number(margin.toFixed(4));
}

async function getFeedMap() {
  const feedRows = await roughCountryFeed();
  const map = new Map();

  for (const row of feedRows || []) {
    const vendorSku = String(row?.SKU || '').trim();
    if (!vendorSku) continue;

    map.set(vendorSku, {
      retailPrice: Number.isFinite(Number(row?.PRICE))
        ? Number(row?.PRICE)
        : Number(row?.SALE_PRICE),
      costUsd: Number(row?.COST),
    });
  }

  return map;
}

async function getRoughCountryPriceRows(brandName, limit = null) {
  const normalizedBrand = normalize(brandName);
  if (!normalizedBrand) {
    throw new Error('--brand requires a non-empty value');
  }

  const feedMap = await getFeedMap();

  const products = await prisma.product.findMany({
    where: {
      brand_name: {
        equals: brandName,
        mode: 'insensitive',
      },
      sku: {
        not: {
          endsWith: '-',
        },
      },
    },
    select: {
      sku: true,
      brand_name: true,
      searchable_sku: true,
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  let skippedMissingRetail = 0;
  let skippedMissingFeedSku = 0;
  let skippedInvalidPrice = 0;
  let mapProtectionAdjustedCount = 0;
  let rowsWithFinalMargin = 0;
  let rowsMissingCostForMargin = 0;
  let minFinalMargin = null;
  let maxFinalMargin = null;
  let sumFinalMargin = 0;

  for (const product of products) {
    if (normalize(product.brand_name) !== normalizedBrand) {
      continue;
    }

    const feedSku = String(product.searchable_sku || '').trim();
    if (!feedSku || !feedMap.has(feedSku)) {
      skippedMissingFeedSku++;
      continue;
    }

    const feedData = feedMap.get(feedSku);
    const retailUsd = Number(feedData.retailPrice);
    const costUsd = Number(feedData.costUsd);

    if (!Number.isFinite(retailUsd) || retailUsd <= 0) {
      skippedMissingRetail++;
      continue;
    }

    const computedBase = retailUsd / 0.85;
    const finalPrice = toUsStorePrice(retailUsd);
    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      skippedInvalidPrice++;
      continue;
    }

    if (!isSamePrice(computedBase, finalPrice)) {
      mapProtectionAdjustedCount++;
    }

    const finalMargin = calculateFinalMargin(finalPrice, costUsd);
    if (finalMargin == null) {
      rowsMissingCostForMargin++;
    } else {
      rowsWithFinalMargin++;
      sumFinalMargin += finalMargin;
      minFinalMargin = minFinalMargin == null ? finalMargin : Math.min(minFinalMargin, finalMargin);
      maxFinalMargin = maxFinalMargin == null ? finalMargin : Math.max(maxFinalMargin, finalMargin);
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_US,
      price: finalPrice,
      map_price: retailUsd,
      vendor_cost_usd: Number.isFinite(costUsd) ? costUsd : null,
      final_margin: finalMargin,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedMissingRetail,
    skippedMissingFeedSku,
    skippedInvalidPrice,
    mapProtectionAdjustedCount,
    rowsWithFinalMargin,
    rowsMissingCostForMargin,
    avgFinalMargin: rowsWithFinalMargin > 0 ? Number((sumFinalMargin / rowsWithFinalMargin).toFixed(4)) : null,
    minFinalMargin,
    maxFinalMargin,
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
  console.log('Update Magento US store base prices for products where brand is Rough Country.');
  console.log('MAP/retail source: price from Rough Country feed (fallback: sale_price).');
  console.log('Formula: price = roundUpToPoint95(retail / 0.85).');
  console.log('This keeps post-promo price (15% off) at or above MAP/retail.');
  console.log('Final margin report: ((price * 0.85) - cost_usd) / cost_usd');
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-rough-country-only-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --brand <name>         Brand value in Product.brand_name (default: Rough Country)');
  console.log('  --vendor <name>        Alias for --brand (backward compatibility)');
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

  console.log('🚀 US Store Rough Country-Only Price Update');
  console.log(`🏷️  Brand filter: ${options.brandName}`);
  console.log('🧮 Formula: roundUpToPoint95(retail / 0.85)  (15% promo-safe vs MAP)');

  const {
    rows,
    scanned,
    skippedMissingRetail,
    skippedMissingFeedSku,
    skippedInvalidPrice,
    mapProtectionAdjustedCount,
    rowsWithFinalMargin,
    rowsMissingCostForMargin,
    avgFinalMargin,
    minFinalMargin,
    maxFinalMargin,
  } = await getRoughCountryPriceRows(options.brandName, options.limit);

  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`⚠️ Skipped (missing feed sku/searchable_sku): ${skippedMissingFeedSku}`);
  console.log(`⚠️ Skipped (missing price): ${skippedMissingRetail}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  console.log(`🛡️ MAP-safe .95 adjustment applied: ${mapProtectionAdjustedCount}`);
  console.log(`📈 Rows with final margin: ${rowsWithFinalMargin}`);
  console.log(`⚠️ Rows missing/invalid cost for margin: ${rowsMissingCostForMargin}`);
  if (rowsWithFinalMargin > 0) {
    console.log(`📈 Final margin avg/min/max: ${avgFinalMargin} / ${minFinalMargin} / ${maxFinalMargin}`);
  }

  if (rows.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  if (options.dryRun) {
    console.log('🧪 Dry run mode enabled. No Magento API calls sent.');
    console.log('Sample (20) SKUs to update:', rows.slice(0, 20));
    return;
  }

  const batches = chunk(rows, options.batchSize);
  let sent = 0;
  let failedBatches = 0;
  const liveUpdatedSamples = [];

  for (let i = 0; i < batches.length; i++) {
    const prices = batches[i].map((row) => ({
      sku: row.sku,
      store_id: row.store_id,
      price: row.price,
    }));

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
  console.log(`   - Total prepared: ${rows.length}`);
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
