#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const { ensureUsWebsiteAssignmentForSkus } = require('./ensure-us-website-assignment');

dotenv.config();

const STORE_ID_US = 2;
const KEYPARTS_VENDOR_NEEDLES = ['keyparts', 'key parts'];
const KEYPARTS_FINAL_MARGIN = 0.4;
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

function hasKeyPartsVendor(vendorsField) {
  const normalized = normalize(vendorsField);
  if (!normalized) return false;

  const vendorTokens = normalized
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  return KEYPARTS_VENDOR_NEEDLES.some(
    (needle) => vendorTokens.includes(needle) || normalized.includes(needle)
  );
}

function toUsStorePriceFromCost(costUsd, finalMargin = KEYPARTS_FINAL_MARGIN) {
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

async function getKeyPartsOnlyPriceRows(limit = null) {
  const keyPartsVendor = await prisma.vendor.findFirst({
    where: {
      OR: [
        {
          name: {
            contains: 'KeyParts',
            mode: 'insensitive',
          },
        },
        {
          name: {
            contains: 'Key Parts',
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

  if (!keyPartsVendor) {
    throw new Error('Could not find vendor containing "KeyParts" or "Key Parts" in Vendor.name');
  }

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      OR: [
        {
          vendors: {
            contains: 'KeyParts',
            mode: 'insensitive',
          },
        },
        {
          vendors: {
            contains: 'Key Parts',
            mode: 'insensitive',
          },
        },
      ],
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
          vendor_id: keyPartsVendor.id,
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
  let skippedMissingCostUsd = 0;
  let skippedInvalidPrice = 0;

  for (const product of products) {
    if (!hasKeyPartsVendor(product.vendors)) {
      skippedVendorMismatch++;
      continue;
    }

    const vp = product.vendorProducts?.[0];
    const keyPartsCostUsd = vp?.vendor_cost_usd;
    if (!Number.isFinite(Number(keyPartsCostUsd)) || Number(keyPartsCostUsd) <= 0) {
      skippedMissingCostUsd++;
      continue;
    }

    const priceUsd = toUsStorePriceFromCost(keyPartsCostUsd);
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
      vendor_cost_used: Number(keyPartsCostUsd),
      brand_name: product.brand_name,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedVendorMismatch,
    skippedMissingCostUsd,
    skippedInvalidPrice,
    keyPartsVendorName: keyPartsVendor.name,
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
  console.log('Update Magento US store base prices for products where vendors contains KeyParts.');
  console.log('Formula:');
  console.log(`  - price_usd = roundUpToPoint95((keyparts_vendor_cost_usd * ${(1 + KEYPARTS_FINAL_MARGIN).toFixed(2)}) / ${MAGENTO_DISCOUNT_FACTOR})`);
  console.log(`  - Targets final margin: ${(KEYPARTS_FINAL_MARGIN * 100).toFixed(0)}% on KeyParts vendor cost USD`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-keyparts-only-prices-us-store.js [options]');
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

  console.log('🚀 US Store KeyParts Price Update');
  console.log(`🧮 Margin target: ${(KEYPARTS_FINAL_MARGIN * 100).toFixed(0)}% final margin on KeyParts cost USD`);

  const {
    rows,
    scanned,
    skippedVendorMismatch,
    skippedMissingCostUsd,
    skippedInvalidPrice,
    keyPartsVendorName,
    byBrand,
  } = await getKeyPartsOnlyPriceRows(options.limit);

  console.log(`🏷️  KeyParts vendor source: ${keyPartsVendorName}`);
  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`⚠️ Skipped (vendor mismatch): ${skippedVendorMismatch}`);
  console.log(`⚠️ Skipped (missing/invalid KeyParts cost USD): ${skippedMissingCostUsd}`);
  console.log(`⚠️ Skipped (invalid computed price): ${skippedInvalidPrice}`);
  if (byBrand.length > 0) {
    console.log('📊 KeyParts SKUs by brand:', byBrand);
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
