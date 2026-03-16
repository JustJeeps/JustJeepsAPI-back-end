#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const { ensureUsWebsiteAssignmentForSkus } = require('./ensure-us-website-assignment');

dotenv.config();

const VENDOR_ID_QUADRATEC = 4;
const STORE_ID_US = 2;
const MIN_FINAL_MARGIN = 0.15;
const MIN_PRICE_USD = 11.95;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalizeVendorName(value) {
  return (value || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const options = {
    vendorName: 'quadratec',
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--vendor' && argv[i + 1]) {
      options.vendorName = argv[++i];
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

function toUsStorePrice(vendorRetailPriceUsd, vendorCostUsd) {
  const retailUsd = Number(vendorRetailPriceUsd);
  const costUsd = Number(vendorCostUsd);
  if (!Number.isFinite(retailUsd) || retailUsd <= 0) return null;

  const useEdgeCaseMargin = Number.isFinite(costUsd) && isSamePrice(retailUsd, costUsd);
  const multiplier = useEdgeCaseMargin ? 1.2 : 0.95;
  const roundedWhole = Math.round((retailUsd * multiplier) / 0.85);
  const finalPrice = roundedWhole - 0.05;
  return {
    price: Number(finalPrice.toFixed(2)),
    usedEdgeCaseMargin: useEdgeCaseMargin,
  };
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

function applyMinMarginFloor(price, costUsd, minMargin = MIN_FINAL_MARGIN) {
  const cost = Number(costUsd);
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
  const flooredToPoint95 = Math.ceil(requiredPrice + 0.05) - 0.05;

  return {
    price: Number(flooredToPoint95.toFixed(2)),
    marginFloorApplied: true,
  };
}

function applyMinPriceFloor(price, minPrice = MIN_PRICE_USD) {
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

async function getQuadratecOnlyPriceRows(vendorName, limit = null) {
  const normalizedVendor = normalizeVendorName(vendorName);
  if (!normalizedVendor) {
    throw new Error('--vendor requires a non-empty value');
  }

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      vendors: {
        equals: vendorName,
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
      vendors: true,
      vendorProducts: {
        where: { vendor_id: VENDOR_ID_QUADRATEC },
        select: {
          vendor_retail_price_usd: true,
          vendor_cost_usd: true,
        },
        take: 1,
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  let skippedVendorMismatch = 0;
  let skippedMissingRetail = 0;
  let skippedInvalidPrice = 0;
  let usedEdgeCaseMarginCount = 0;
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
    if (!vp || vp.vendor_retail_price_usd == null) {
      skippedMissingRetail++;
      continue;
    }

    const result = toUsStorePrice(vp.vendor_retail_price_usd, vp.vendor_cost_usd);
    if (result == null || result.price <= 0) {
      skippedInvalidPrice++;
      continue;
    }

    if (result.usedEdgeCaseMargin) {
      usedEdgeCaseMarginCount++;
    }

    const floorAdjusted = applyMinMarginFloor(result.price, vp.vendor_cost_usd);
    if (floorAdjusted.marginFloorApplied) {
      minMarginFloorAppliedCount++;
    }

    const minPriceAdjusted = applyMinPriceFloor(floorAdjusted.price);
    if (minPriceAdjusted.minPriceFloorApplied) {
      minPriceFloorAppliedCount++;
    }

    const finalMargin = calculateFinalMargin(minPriceAdjusted.price, vp.vendor_cost_usd);
    if (finalMargin != null) {
      rowsWithFinalMargin++;
      sumFinalMargin += finalMargin;
      minFinalMargin = minFinalMargin == null ? finalMargin : Math.min(minFinalMargin, finalMargin);
      maxFinalMargin = maxFinalMargin == null ? finalMargin : Math.max(maxFinalMargin, finalMargin);
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_US,
      price: minPriceAdjusted.price,
      vendor_cost_usd: vp.vendor_cost_usd,
      final_margin: finalMargin,
      min_margin_floor_applied: floorAdjusted.marginFloorApplied,
      min_price_floor_applied: minPriceAdjusted.minPriceFloorApplied,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedVendorMismatch,
    skippedMissingRetail,
    skippedInvalidPrice,
    usedEdgeCaseMarginCount,
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
  console.log('Update Magento US store base prices for products where vendors is Quadratec only.');
  console.log('Formula:');
  console.log('  - Standard: round((vendor_retail_price_usd * 0.95) / 0.85, 0) - 0.05');
  console.log('  - Edge case (retail == cost): round((vendor_retail_price_usd * 1.2) / 0.85, 0) - 0.05');
  console.log(`  - Margin floor: if final margin < ${(MIN_FINAL_MARGIN * 100).toFixed(0)}%, lift to minimum and keep .95 ending`);
  console.log(`  - Min price floor: ${MIN_PRICE_USD.toFixed(2)}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-quadratec-only-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --vendor <name>        Vendor value in Product.vendors (default: quadratec)');
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

  console.log('🚀 US Store Quadratec-Only Price Update');
  console.log(`🏷️  Vendor filter: ${options.vendorName}`);
  console.log('🧮 Formula: standard 0.95, edge-case (retail == cost) 1.2, then /0.85, round, -0.05');

  const {
    rows,
    scanned,
    skippedVendorMismatch,
    skippedMissingRetail,
    skippedInvalidPrice,
    usedEdgeCaseMarginCount,
    rowsWithFinalMargin,
    avgFinalMargin,
    minFinalMargin,
    maxFinalMargin,
    minMarginFloorAppliedCount,
    minPriceFloorAppliedCount,
  } = await getQuadratecOnlyPriceRows(options.vendorName, options.limit);

  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`⚠️ Skipped (vendor mismatch): ${skippedVendorMismatch}`);
  console.log(`⚠️ Skipped (missing retail price): ${skippedMissingRetail}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  console.log(`🧩 Edge-case formula used (retail == cost): ${usedEdgeCaseMarginCount}`);
  console.log(`🛡️ Min-margin floor applied: ${minMarginFloorAppliedCount}`);
  console.log(`🧱 Min-price floor applied (${MIN_PRICE_USD.toFixed(2)}): ${minPriceFloorAppliedCount}`);
  console.log(`📈 Rows with final margin: ${rowsWithFinalMargin}`);
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

  const websiteSync = await ensureUsWebsiteAssignmentForSkus({
    skus: rows.map((row) => row.sku),
    websiteId: STORE_ID_US,
    magentoConfig: MAGENTO_CONFIG,
  });

  console.log('🌐 US website assignment sync:', {
    total: websiteSync.total,
    assigned: websiteSync.assigned,
    alreadyAssigned: websiteSync.alreadyAssigned,
    missingInMagento: websiteSync.missingInMagento,
    failed: websiteSync.failed,
  });
  if (websiteSync.failedSamples.length > 0) {
    console.log('⚠️ Website assignment failure samples:', websiteSync.failedSamples);
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
