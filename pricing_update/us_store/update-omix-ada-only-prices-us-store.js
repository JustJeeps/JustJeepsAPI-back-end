#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');

dotenv.config();

const STORE_ID_US = 2;
const OMIX_VENDOR_NEEDLES = ['omix-ada', 'omix'];
const OMIX_FINAL_MARGIN = 0.3;
const MAGENTO_DISCOUNT_FACTOR = 0.85;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const options = {
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--limit' && argv[i + 1]) {
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

function hasOmixVendor(vendorsField) {
  const normalized = normalize(vendorsField);
  if (!normalized) return false;

  const vendorTokens = normalized
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  return OMIX_VENDOR_NEEDLES.some(
    (needle) => vendorTokens.includes(needle) || normalized.includes(needle)
  );
}

function toUsStorePriceFromCost(costUsd, finalMargin = OMIX_FINAL_MARGIN) {
  const cost = Number(costUsd);
  const margin = Number(finalMargin);

  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (!Number.isFinite(margin) || margin < 0) return null;

  const requiredPrice = (cost * (1 + margin)) / MAGENTO_DISCOUNT_FACTOR;
  const roundedToPoint95 = Math.ceil(requiredPrice + 0.05) - 0.05;
  return Number(roundedToPoint95.toFixed(2));
}

function toSortedCountRows(map) {
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function getOmixOnlyPriceRows(limit = null) {
  const omixVendor = await prisma.vendor.findFirst({
    where: {
      OR: [
        {
          name: {
            contains: 'Omix-ADA',
            mode: 'insensitive',
          },
        },
        {
          name: {
            contains: 'Omix',
            mode: 'insensitive',
          },
        },
      ],
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!omixVendor) {
    throw new Error('Could not find vendor containing "Omix-ADA" or "Omix" in Vendor.name');
  }

  const products = await prisma.product.findMany({
    where: {
      vendors: {
        contains: 'Omix',
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
          vendor_id: omixVendor.id,
        },
        select: {
          vendor_cost_usd: true,
          vendor_cost: true,
        },
        take: 1,
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  const byBrandCounts = new Map();

  let skippedVendorMismatch = 0;
  let skippedMissingCost = 0;
  let skippedInvalidPrice = 0;

  for (const product of products) {
    if (!hasOmixVendor(product.vendors)) {
      skippedVendorMismatch++;
      continue;
    }

    const vp = product.vendorProducts?.[0];
    const omixCost = vp?.vendor_cost_usd ?? vp?.vendor_cost;
    if (!Number.isFinite(Number(omixCost)) || Number(omixCost) <= 0) {
      skippedMissingCost++;
      continue;
    }

    const priceUsd = toUsStorePriceFromCost(omixCost);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      skippedInvalidPrice++;
      continue;
    }

    const brandKey = normalize(product.brand_name) || '(blank)';
    byBrandCounts.set(brandKey, (byBrandCounts.get(brandKey) || 0) + 1);

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_US,
      price: priceUsd,
      vendor_cost_used: Number(omixCost),
      brand_name: product.brand_name,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedVendorMismatch,
    skippedMissingCost,
    skippedInvalidPrice,
    omixVendorName: omixVendor.name,
    byBrand: toSortedCountRows(byBrandCounts),
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
  console.log('Update Magento US store base prices for products where vendors contains Omix-ADA.');
  console.log('Formula:');
  console.log(`  - price_usd = roundUpToPoint95((omix_vendor_cost * ${(1 + OMIX_FINAL_MARGIN).toFixed(2)}) / ${MAGENTO_DISCOUNT_FACTOR})`);
  console.log(`  - Targets final margin: ${(OMIX_FINAL_MARGIN * 100).toFixed(0)}% on Omix vendor cost`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-omix-ada-only-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
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

  console.log('🚀 US Store Omix-ADA Price Update');
  console.log(`🧮 Margin target: ${(OMIX_FINAL_MARGIN * 100).toFixed(0)}% final margin on Omix cost`);

  const {
    rows,
    scanned,
    skippedVendorMismatch,
    skippedMissingCost,
    skippedInvalidPrice,
    omixVendorName,
    byBrand,
  } = await getOmixOnlyPriceRows(options.limit);

  console.log(`🏷️  Omix vendor source: ${omixVendorName}`);
  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`⚠️ Skipped (vendor mismatch): ${skippedVendorMismatch}`);
  console.log(`⚠️ Skipped (missing/invalid Omix cost): ${skippedMissingCost}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  if (byBrand.length > 0) {
    console.log('📊 Omix SKUs by brand:', byBrand);
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
