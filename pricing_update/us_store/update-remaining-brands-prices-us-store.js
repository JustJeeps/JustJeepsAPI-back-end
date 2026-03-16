#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');
const { ensureUsWebsiteAssignmentForSkus } = require('./ensure-us-website-assignment');

dotenv.config();

const STORE_ID_US = 2;
const CAD_TO_USD_RATE = 0.72;

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseListArg(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalize(item))
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    excludeBrands: ['rough country', 'metalcloak','KeyParts','American Expedition Vehicles (MAP)','Mopar' ],
    excludeVendors: ['quadratec'],
    excludeVendorsContains: ['omix', 'keyparts'],
    limit: null,
    batchSize: 1000,
    delayMs: 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--exclude-brands' && argv[i + 1]) {
      options.excludeBrands = parseListArg(argv[++i]);
    } else if (arg === '--exclude-vendors' && argv[i + 1]) {
      options.excludeVendors = parseListArg(argv[++i]);
    } else if (arg === '--exclude-vendors-contains' && argv[i + 1]) {
      options.excludeVendorsContains = parseListArg(argv[++i]);
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

function toUsStorePriceFromCad(cadPrice, conversionRate = CAD_TO_USD_RATE) {
  const cad = Number(cadPrice);
  const rate = Number(conversionRate);

  if (!Number.isFinite(cad) || cad <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const convertedUsd = cad * rate;
  return Number((Math.ceil(convertedUsd + 0.05) - 0.05).toFixed(2));
}

function shouldExcludeProduct(product, excludeBrandsSet, excludeVendorsSet, excludeVendorsContainsList) {
  const brand = normalize(product.brand_name);
  const vendors = normalize(product.vendors);
  const brandExcluded = !!(brand && excludeBrandsSet.has(brand));
  const vendorExcludedExact = !!(vendors && excludeVendorsSet.has(vendors));

  let matchedVendorContains = null;
  if (vendors && Array.isArray(excludeVendorsContainsList)) {
    for (const needle of excludeVendorsContainsList) {
      if (needle && vendors.includes(needle)) {
        matchedVendorContains = needle;
        break;
      }
    }
  }

  const vendorExcludedContains = !!matchedVendorContains;
  const vendorExcluded = vendorExcludedExact || vendorExcludedContains;

  return {
    excluded: brandExcluded || vendorExcluded,
    brandExcluded,
    vendorExcludedExact,
    vendorExcludedContains,
    vendorExcluded,
    matchedVendorContains,
    brand,
    vendors,
  };
}

function toSortedCountRows(map) {
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function getRemainingBrandsPriceRows(options) {
  const products = await prisma.product.findMany({
    where: {
      status: 1,
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
      price: true,
    },
    ...(options.limit ? { take: options.limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const excludeBrandsSet = new Set(options.excludeBrands.map((value) => normalize(value)).filter(Boolean));
  const excludeVendorsSet = new Set(options.excludeVendors.map((value) => normalize(value)).filter(Boolean));
  const excludeVendorsContains = options.excludeVendorsContains.map((value) => normalize(value)).filter(Boolean);

  const rows = [];
  let skippedExcluded = 0;
  let skippedInvalidCadPrice = 0;
  const excludedByBrandCounts = new Map();
  const excludedByVendorCounts = new Map();
  const excludedByVendorContainsCounts = new Map();

  for (const product of products) {
    const exclusion = shouldExcludeProduct(product, excludeBrandsSet, excludeVendorsSet, excludeVendorsContains);
    if (exclusion.excluded) {
      skippedExcluded++;

      if (exclusion.brandExcluded) {
        const key = exclusion.brand || '(blank)';
        excludedByBrandCounts.set(key, (excludedByBrandCounts.get(key) || 0) + 1);
      }

      if (exclusion.vendorExcludedExact) {
        const key = exclusion.vendors || '(blank)';
        excludedByVendorCounts.set(key, (excludedByVendorCounts.get(key) || 0) + 1);
      }

      if (exclusion.vendorExcludedContains) {
        const key = exclusion.matchedVendorContains || '(blank)';
        excludedByVendorContainsCounts.set(key, (excludedByVendorContainsCounts.get(key) || 0) + 1);
      }

      continue;
    }

    const priceUsd = toUsStorePriceFromCad(product.price);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      skippedInvalidCadPrice++;
      continue;
    }

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_US,
      price: priceUsd,
      cad_price: product.price,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedExcluded,
    skippedInvalidCadPrice,
    excludeBrands: Array.from(excludeBrandsSet),
    excludeVendors: Array.from(excludeVendorsSet),
    excludeVendorsContains,
    excludedByBrand: toSortedCountRows(excludedByBrandCounts),
    excludedByVendor: toSortedCountRows(excludedByVendorCounts),
    excludedByVendorContains: toSortedCountRows(excludedByVendorContainsCounts),
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
  console.log('Update Magento US store base prices for remaining brands using CAD Product.price conversion.');
  console.log(`Formula: price_usd = roundUpToPoint95(Product.price * ${CAD_TO_USD_RATE})`);
  console.log('Defaults exclude products already handled by other scripts:');
  console.log('  - Brand: Rough Country');
  console.log('  - Brand: MetalCloak');
  console.log('  - Vendor exact match: quadratec');
  console.log('  - Vendor contains: omix, keyparts');
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-remaining-brands-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --exclude-brands <csv>   Comma-separated Product.brand_name exclusions');
  console.log('                           (default: "Rough Country, MetalCloak")');
  console.log('  --exclude-vendors <csv>  Comma-separated Product.vendors exclusions');
  console.log('                           Exact full-field match (default: "quadratec")');
  console.log('  --exclude-vendors-contains <csv>  Exclude if Product.vendors contains any value');
  console.log('                           (default: "omix,keyparts")');
  console.log('  --limit <number>         Limit products fetched from DB');
  console.log('  --batch-size <number>    Prices per Magento request (default: 1000)');
  console.log('  --delay-ms <number>      Delay between batches in milliseconds (default: 400)');
  console.log('  --dry-run                Print sample payload only, do not send updates');
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

  console.log('🚀 US Store Remaining-Brands Price Update');
  console.log(`🧮 Formula: USD = roundUpToPoint95(CAD * ${CAD_TO_USD_RATE})`);

  const {
    rows,
    scanned,
    skippedExcluded,
    skippedInvalidCadPrice,
    excludeBrands,
    excludeVendors,
    excludeVendorsContains,
    excludedByBrand,
    excludedByVendor,
    excludedByVendorContains,
  } = await getRemainingBrandsPriceRows(options);

  console.log(`📦 Products scanned: ${scanned}`);
  console.log(`✅ Price rows prepared: ${rows.length}`);
  console.log(`⚠️ Skipped (excluded by brand/vendor): ${skippedExcluded}`);
  console.log(`⚠️ Skipped (invalid CAD price): ${skippedInvalidCadPrice}`);
  console.log(`⛔ Excluded brands: ${excludeBrands.length ? excludeBrands.join(', ') : '(none)'}`);
  console.log(`⛔ Excluded vendors: ${excludeVendors.length ? excludeVendors.join(', ') : '(none)'}`);
  console.log(`⛔ Excluded vendors (contains): ${excludeVendorsContains.length ? excludeVendorsContains.join(', ') : '(none)'}`);
  if (excludedByBrand.length > 0) {
    console.log('📊 Excluded SKUs by brand:', excludedByBrand);
  }
  if (excludedByVendor.length > 0) {
    console.log('📊 Excluded SKUs by vendor:', excludedByVendor);
  }
  if (excludedByVendorContains.length > 0) {
    console.log('📊 Excluded SKUs by vendor contains:', excludedByVendorContains);
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
