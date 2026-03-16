#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const { ensureUsWebsiteAssignmentForSkus } = require('./ensure-us-website-assignment');

dotenv.config();

const STORE_ID_US = 2;
const VENDOR_ID_MEYER = 2;
const VENDOR_ID_QUADRATEC = 4;
const CAD_TO_USD_RATE = 0.72;
const MIN_FINAL_MARGIN = 0.15;
const MIN_PRICE_USD = 11.95;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

const MAGENTO_US_STATUS_CONFIG = {
  baseURL: process.env.M2_BASE_URL || 'https://www.justjeeps.com/rest/us_sv/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const options = {
    brandName: 'Mopar',
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    disableMissing: true,
    disableStatus: 2,
    disableConcurrency: 15,
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
    } else if (arg === '--disable-concurrency' && argv[i + 1]) {
      options.disableConcurrency = Number(argv[++i]);
    } else if (arg === '--disable-status' && argv[i + 1]) {
      options.disableStatus = Number(argv[++i]);
    } else if (arg === '--no-disable-missing') {
      options.disableMissing = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function isSamePrice(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.00001;
}

function toUsStorePriceFromQuadratec(vendorRetailPriceUsd, vendorCostUsd) {
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

function toUsStorePriceFromMeyerCad(cadCost, conversionRate = CAD_TO_USD_RATE) {
  const cad = Number(cadCost);
  const rate = Number(conversionRate);
  if (!Number.isFinite(cad) || cad <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const convertedUsd = cad * rate;
  return Number((Math.ceil(convertedUsd + 0.05) - 0.05).toFixed(2));
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) {
    out.push(array.slice(index, index + size));
  }
  return out;
}

async function getMoparRows(brandName, limit = null) {
  const normalizedBrand = normalize(brandName);
  if (!normalizedBrand) {
    throw new Error('--brand requires a non-empty value');
  }

  const products = await prisma.product.findMany({
    where: {
      status: 1,
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
      vendors: true,
      vendorProducts: {
        where: {
          vendor_id: {
            in: [VENDOR_ID_QUADRATEC, VENDOR_ID_MEYER],
          },
        },
        select: {
          vendor_id: true,
          vendor_cost: true,
          vendor_cost_usd: true,
          vendor_retail_price_usd: true,
        },
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  const toDisable = [];

  let pricedByQuadratec = 0;
  let pricedByMeyerCad = 0;
  let skippedInvalidPrice = 0;
  let skippedNoVendorSource = 0;

  for (const product of products) {
    const quadratec = product.vendorProducts.find((vp) => vp.vendor_id === VENDOR_ID_QUADRATEC);
    const meyer = product.vendorProducts.find((vp) => vp.vendor_id === VENDOR_ID_MEYER);

    const hasQuadRetail = Number.isFinite(Number(quadratec?.vendor_retail_price_usd))
      && Number(quadratec?.vendor_retail_price_usd) > 0;

    if (hasQuadRetail) {
      const base = toUsStorePriceFromQuadratec(quadratec.vendor_retail_price_usd, quadratec.vendor_cost_usd);
      if (!base || base.price <= 0) {
        skippedInvalidPrice++;
        continue;
      }

      const minMarginAdjusted = applyMinMarginFloor(base.price, quadratec.vendor_cost_usd);
      const minPriceAdjusted = applyMinPriceFloor(minMarginAdjusted.price);

      rows.push({
        sku: product.sku,
        store_id: STORE_ID_US,
        price: minPriceAdjusted.price,
        source: 'quadratec',
      });
      pricedByQuadratec++;
      continue;
    }

    const hasMeyerCad = Number.isFinite(Number(meyer?.vendor_cost)) && Number(meyer?.vendor_cost) > 0;
    if (hasMeyerCad) {
      const price = toUsStorePriceFromMeyerCad(meyer.vendor_cost);
      if (!Number.isFinite(price) || price <= 0) {
        skippedInvalidPrice++;
        continue;
      }

      rows.push({
        sku: product.sku,
        store_id: STORE_ID_US,
        price,
        source: 'meyer_cad',
      });
      pricedByMeyerCad++;
      continue;
    }

    skippedNoVendorSource++;
    toDisable.push(product.sku);
  }

  return {
    rows,
    toDisable,
    scanned: products.length,
    pricedByQuadratec,
    pricedByMeyerCad,
    skippedInvalidPrice,
    skippedNoVendorSource,
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

async function setUsStoreStatus(sku, status) {
  const payload = {
    product: {
      status,
    },
  };

  const url = `${MAGENTO_US_STATUS_CONFIG.baseURL}/products/${encodeURIComponent(sku)}`;
  const requestConfig = {
    headers: {
      Authorization: `Bearer ${MAGENTO_US_STATUS_CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    timeout: MAGENTO_US_STATUS_CONFIG.timeout,
  };

  try {
    const response = await axios.put(url, payload, requestConfig);
    return { success: true, sku, method: 'PUT', statusCode: response.status };
  } catch (error) {
    if (error.response?.status === 405) {
      const response = await axios.post(url, payload, requestConfig);
      return { success: true, sku, method: 'POST', statusCode: response.status };
    }

    return {
      success: false,
      sku,
      statusCode: error.response?.status,
      error: error.response?.data || error.message,
    };
  }
}

async function disableSkusInUsStore(skus, status = 2, concurrency = 15) {
  const uniqueSkus = Array.from(new Set((skus || []).map((sku) => String(sku || '').trim()).filter(Boolean)));

  const stats = {
    total: uniqueSkus.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < uniqueSkus.length; i += concurrency) {
    const group = uniqueSkus.slice(i, i + concurrency);
    const results = await Promise.all(group.map((sku) => setUsStoreStatus(sku, status)));

    for (const result of results) {
      if (result.success) {
        stats.success++;
      } else {
        stats.failed++;
        stats.errors.push(result);
      }
    }
  }

  return stats;
}

function printUsage() {
  console.log('Update Mopar prices in US store using Quadratec first, Meyer CAD fallback, and disable missing-source SKUs.');
  console.log('Pricing rules:');
  console.log('  - Quadratec: existing Quadratec formula (retail/USD aware)');
  console.log(`  - Meyer fallback: CAD cost * ${CAD_TO_USD_RATE}, rounded to .95`);
  console.log('  - Downsview is ignored for US pricing');
  console.log('  - If no Quadratec/Meyer source, SKU can be disabled on US store view');
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-mopar-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --brand <name>             Product.brand_name filter (default: Mopar)');
  console.log('  --limit <number>           Limit products fetched from DB');
  console.log('  --batch-size <number>      Prices per Magento request (default: 1000)');
  console.log('  --delay-ms <number>        Delay between batches in milliseconds (default: 400)');
  console.log('  --disable-concurrency <n>  Concurrent disable calls (default: 15)');
  console.log('  --disable-status <n>       US store status value when disabling (default: 2)');
  console.log('  --no-disable-missing       Do not disable SKUs missing both sources');
  console.log('  --dry-run                  Print samples only, do not send updates');
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

  if (!Number.isInteger(options.disableStatus) || options.disableStatus < 1) {
    throw new Error('Invalid --disable-status. Expected integer >= 1.');
  }

  if (!Number.isInteger(options.disableConcurrency) || options.disableConcurrency < 1) {
    throw new Error('Invalid --disable-concurrency. Expected integer >= 1.');
  }

  if (!options.dryRun && !MAGENTO_CONFIG.token) {
    throw new Error('MAGENTO_KEY is required unless --dry-run is used');
  }

  const startedAt = Date.now();

  console.log('🚀 US Store Mopar Price Update');
  console.log(`🏷️  Brand filter: ${options.brandName}`);
  console.log(`🧮 Meyer CAD conversion rate: ${CAD_TO_USD_RATE}`);

  const {
    rows,
    toDisable,
    scanned,
    pricedByQuadratec,
    pricedByMeyerCad,
    skippedInvalidPrice,
    skippedNoVendorSource,
  } = await getMoparRows(options.brandName, options.limit);

  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`✅ Priced by Quadratec: ${pricedByQuadratec}`);
  console.log(`✅ Priced by Meyer CAD fallback: ${pricedByMeyerCad}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  console.log(`⚠️ Missing both Quad+Meyer source: ${skippedNoVendorSource}`);

  if (options.dryRun) {
    console.log('🧪 Dry run mode enabled. No Magento API calls sent.');
    console.log('Sample (20) SKUs to update:', rows.slice(0, 20));
    if (options.disableMissing) {
      console.log('Sample (20) SKUs to disable on US store:', toDisable.slice(0, 20));
    }
    return;
  }

  if (rows.length > 0) {
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

      console.log(`✅ Batch ${i + 1}/${batches.length} sent (${prices.length} SKUs) | HTTP ${response.status}`);
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

  let disableStats = null;
  if (options.disableMissing && toDisable.length > 0) {
    disableStats = await disableSkusInUsStore(toDisable, options.disableStatus, options.disableConcurrency);
    console.log('🚫 US disable sync for missing-source SKUs:', {
      total: disableStats.total,
      success: disableStats.success,
      failed: disableStats.failed,
    });
    if (disableStats.errors.length > 0) {
      console.log('⚠️ Disable error samples:', disableStats.errors.slice(0, 20));
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n✅ Job complete');
  console.log(`   - Total prepared: ${rows.length}`);
  console.log(`   - Total sent: ${sent}`);
  console.log(`   - Failed batches: ${failedBatches}`);
  if (options.disableMissing) {
    console.log(`   - Missing-source SKUs targeted for disable: ${toDisable.length}`);
    if (disableStats) {
      console.log(`   - Disabled success/failed: ${disableStats.success}/${disableStats.failed}`);
    }
  }
  console.log(`   - Elapsed: ${elapsedSeconds}s`);

  if (liveUpdatedSamples.length > 0) {
    console.log('   - Sample (20) updated SKUs:', liveUpdatedSamples);
  }

  if (failedBatches > 0 || (disableStats && disableStats.failed > 0)) {
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
