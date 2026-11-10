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
const FAKE_PROMO_FACTOR = 0.85;
const DEFAULT_BEAT_PERCENT = 7;
const DEFAULT_BRANDS = ['OMIX-ADA', 'Rugged Ridge', 'Alloy'];
const DEFAULT_MAGENTO_REST_BASE_URL = 'https://justjeeps.com/rest/default/V1';

function resolveMagentoRestBaseUrl() {
  const configured = (
    process.env.MAGENTO_BASE_URL ||
    process.env.M2_BASE_URL_DEFAULT ||
    process.env.M2_DEFAULT_BASE_URL ||
    process.env.M2_BASE_URL ||
    DEFAULT_MAGENTO_REST_BASE_URL
  ).trim();

  const base = configured || DEFAULT_MAGENTO_REST_BASE_URL;
  const withoutTrailingSlash = base.replace(/\/+$/, '');

  if (/\/rest\/[^/]+\/V1$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash.replace('https://www.justjeeps.com', 'https://justjeeps.com');
  }

  if (/\/rest\/V1$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash
      .replace(/\/rest\/V1$/i, '/rest/default/V1')
      .replace('https://www.justjeeps.com', 'https://justjeeps.com');
  }

  return `${withoutTrailingSlash.replace('https://www.justjeeps.com', 'https://justjeeps.com')}/rest/default/V1`;
}

const MAGENTO_CONFIG = {
  baseURL: resolveMagentoRestBaseUrl(),
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 30000),
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    brands: [...DEFAULT_BRANDS],
    beatPercent: DEFAULT_BEAT_PERCENT,
    limit: null,
    batchSize: 250,
    delayMs: 400,
    skipWebsiteAssignment: false,
    skipShippingFreightSync: false,
    shippingFreightConcurrency: 15,
    websiteAssignmentConcurrency: 10,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--brands' && argv[i + 1]) {
      const parsed = parseCsvList(argv[++i]);
      if (parsed.length > 0) {
        options.brands = parsed;
      }
    } else if (arg === '--beat-pct' && argv[i + 1]) {
      options.beatPercent = Number(argv[++i]);
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--batch-size' && argv[i + 1]) {
      options.batchSize = Number(argv[++i]);
    } else if (arg === '--delay-ms' && argv[i + 1]) {
      options.delayMs = Number(argv[++i]);
    } else if (arg === '--website-assignment-concurrency' && argv[i + 1]) {
      options.websiteAssignmentConcurrency = Number(argv[++i]);
    } else if (arg === '--shipping-freight-concurrency' && argv[i + 1]) {
      options.shippingFreightConcurrency = Number(argv[++i]);
    } else if (arg === '--skip-website-assignment') {
      options.skipWebsiteAssignment = true;
    } else if (arg === '--skip-shipping-freight-sync') {
      options.skipShippingFreightSync = true;
    } else if (arg === '--sync-shipping-freight') {
      options.skipShippingFreightSync = false;
    } else if (arg === '--sync-website-assignment') {
      options.skipWebsiteAssignment = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function toUsStorePriceFromQuadratecRetail(vendorRetailPriceUsd, beatPercent) {
  const retailUsd = Number(vendorRetailPriceUsd);
  const beat = Number(beatPercent);

  if (!Number.isFinite(retailUsd) || retailUsd <= 0) return null;
  if (!Number.isFinite(beat) || beat < 0 || beat >= 100) return null;

  const beatMultiplier = (100 - beat) / 100;
  const roundedWhole = Math.round((retailUsd * beatMultiplier) / FAKE_PROMO_FACTOR);
  const finalPrice = roundedWhole - 0.05;

  return Number(finalPrice.toFixed(2));
}

function calculateFinalMargin(price, costUsd) {
  const computedPrice = Number(price);
  const cost = Number(costUsd);
  if (!Number.isFinite(computedPrice) || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  const margin = ((computedPrice * FAKE_PROMO_FACTOR) - cost) / cost;
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

  const requiredPrice = (cost * (1 + minMargin)) / FAKE_PROMO_FACTOR;
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

function matchesAnyBrand(brandName, brandNeedles) {
  const normalizedBrand = normalize(brandName);
  if (!normalizedBrand) return false;

  return brandNeedles.some((needle) => normalizedBrand.includes(needle));
}

function toSortedCountRows(map) {
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function getSelectedBrandRows(brands, beatPercent, limit = null) {
  const normalizedBrandNeedles = brands.map(normalize).filter(Boolean);
  if (normalizedBrandNeedles.length === 0) {
    throw new Error('--brands requires at least one non-empty brand value');
  }

  const brandWhere = normalizedBrandNeedles.map((needle) => ({
    brand_name: {
      contains: needle,
      mode: 'insensitive',
    },
  }));

  const products = await prisma.product.findMany({
    where: {
      status: 1,
      OR: brandWhere,
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
        where: { vendor_id: VENDOR_ID_QUADRATEC },
        select: {
          vendor_retail_price_usd: true,
          vendor_cost_usd: true,
          quadratec_shipping_surcharge_usd: true,
        },
        take: 1,
      },
    },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  const rows = [];
  const byBrandCounts = new Map();

  let skippedBrandMismatch = 0;
  let skippedMissingRetail = 0;
  let skippedInvalidPrice = 0;
  let rowsWithFinalMargin = 0;
  let minFinalMargin = null;
  let maxFinalMargin = null;
  let sumFinalMargin = 0;
  let minMarginFloorAppliedCount = 0;
  let minPriceFloorAppliedCount = 0;

  for (const product of products) {
    if (!matchesAnyBrand(product.brand_name, normalizedBrandNeedles)) {
      skippedBrandMismatch++;
      continue;
    }

    const vp = product.vendorProducts?.[0];
    if (!vp || vp.vendor_retail_price_usd == null) {
      skippedMissingRetail++;
      continue;
    }

    const basePrice = toUsStorePriceFromQuadratecRetail(vp.vendor_retail_price_usd, beatPercent);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      skippedInvalidPrice++;
      continue;
    }

    const marginAdjusted = applyMinMarginFloor(basePrice, vp.vendor_cost_usd);
    if (marginAdjusted.marginFloorApplied) {
      minMarginFloorAppliedCount++;
    }

    const minPriceAdjusted = applyMinPriceFloor(marginAdjusted.price);
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

    const brandKey = normalize(product.brand_name) || '(blank)';
    byBrandCounts.set(brandKey, (byBrandCounts.get(brandKey) || 0) + 1);

    rows.push({
      sku: product.sku,
      store_id: STORE_ID_US,
      price: minPriceAdjusted.price,
      brand_name: product.brand_name,
      vendor_cost_usd: vp.vendor_cost_usd,
      quadratec_retail_usd: vp.vendor_retail_price_usd,
      quadratec_shipping_surcharge_usd: vp.quadratec_shipping_surcharge_usd,
      final_margin: finalMargin,
      min_margin_floor_applied: marginAdjusted.marginFloorApplied,
      min_price_floor_applied: minPriceAdjusted.minPriceFloorApplied,
    });
  }

  return {
    rows,
    scanned: products.length,
    skippedBrandMismatch,
    skippedMissingRetail,
    skippedInvalidPrice,
    rowsWithFinalMargin,
    avgFinalMargin: rowsWithFinalMargin > 0 ? Number((sumFinalMargin / rowsWithFinalMargin).toFixed(4)) : null,
    minFinalMargin,
    maxFinalMargin,
    minMarginFloorAppliedCount,
    minPriceFloorAppliedCount,
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
      'User-Agent': 'JustJeepsAPI/price-update',
    },
    maxBodyLength: Infinity,
    timeout: MAGENTO_CONFIG.timeout,
  });

  return response;
}

function normalizeShippingFreight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Number(numeric.toFixed(2)).toString();
}

async function upsertShippingFreightForSku(sku, shippingFreightValue) {
  const encodedSku = encodeURIComponent(sku);
  const productWriteBaseUrl = MAGENTO_CONFIG.baseURL.replace('https://justjeeps.com', 'https://www.justjeeps.com');
  const payload = {
    product: {
      sku,
      custom_attributes: [
        {
          attribute_code: 'shipping_freight',
          value: shippingFreightValue,
        },
      ],
    },
  };

  const config = {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'JustJeepsAPI/price-update',
    },
    params: {
      storeId: STORE_ID_US,
    },
    timeout: MAGENTO_CONFIG.timeout,
  };

  try {
    const response = await axios.put(
      `${productWriteBaseUrl}/products/${encodedSku}`,
      payload,
      config
    );
    return response;
  } catch (error) {
    if (error.response?.status === 405) {
      return axios.post(
        `${productWriteBaseUrl}/products/${encodedSku}`,
        payload,
        config
      );
    }
    throw error;
  }
}

async function syncShippingFreightForRows(rows, concurrency) {
  const result = {
    considered: rows.length,
    queued: 0,
    skippedMissingSurcharge: 0,
    updated: 0,
    failed: 0,
    accessDeniedFailures: 0,
    aborted: false,
    abortReason: null,
    failedSamples: [],
  };

  let index = 0;

  async function worker() {
    while (!result.aborted) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= rows.length) {
        return;
      }

      const row = rows[currentIndex];
      const shippingFreightValue = normalizeShippingFreight(row.quadratec_shipping_surcharge_usd);
      if (shippingFreightValue == null) {
        result.skippedMissingSurcharge += 1;
        continue;
      }

      result.queued += 1;

      try {
        await upsertShippingFreightForSku(row.sku, shippingFreightValue);
        result.updated += 1;
      } catch (error) {
        result.failed += 1;

        if (isAccessDeniedError(error)) {
          result.accessDeniedFailures += 1;
          result.aborted = true;
          result.abortReason = 'Aborted shipping_freight sync after Magento/Sucuri access denied response.';
        }

        if (result.failedSamples.length < 20) {
          result.failedSamples.push({
            sku: row.sku,
            status: error.response?.status || 'ERR',
            message: String(error.response?.data?.message || error.message || '').slice(0, 240),
          });
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return result;
}

function isAccessDeniedError(error) {
  const status = error.response?.status;
  const details = String(error.response?.data || error.message || '').toLowerCase();

  return status === 403 || details.includes('sucuri website firewall') || details.includes('access denied');
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) {
    out.push(array.slice(index, index + size));
  }
  return out;
}

function printUsage() {
  console.log('Update Magento US store base prices for selected brands using Quadratec retail as source.');
  console.log('Formula:');
  console.log('  - price = round((quadratec_vendor_retail_price_usd * (1 - beat_pct/100)) / 0.85, 0) - 0.05');
  console.log(`  - Default beat_pct: ${DEFAULT_BEAT_PERCENT}%`);
  console.log(`  - Margin floor: if final margin < ${(MIN_FINAL_MARGIN * 100).toFixed(0)}%, lift to minimum and keep .95 ending`);
  console.log(`  - Min price floor: ${MIN_PRICE_USD.toFixed(2)}`);
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/update-selected-brands-quadratec-retail-prices-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --brands <csv>         Product.brand_name contains list (default: ${DEFAULT_BRANDS.join(', ')})`);
  console.log(`  --beat-pct <number>    Percent below Quadratec retail (default: ${DEFAULT_BEAT_PERCENT})`);
  console.log('  --limit <number>       Limit products fetched from DB');
  console.log('  --batch-size <number>  Prices per Magento request (default: 250)');
  console.log('  --delay-ms <number>    Delay between batches in milliseconds (default: 400)');
  console.log('  --skip-website-assignment  Skip website assignment sync step');
  console.log('  --sync-website-assignment  Run website assignment sync step even when npm script skips it');
  console.log('  --website-assignment-concurrency <n>  Workers for website sync (default: 10)');
  console.log('  --skip-shipping-freight-sync  Skip shipping_freight update from Quadratec surcharge');
  console.log('  --sync-shipping-freight  Force shipping_freight update (default behavior)');
  console.log('  --shipping-freight-concurrency <n>  Workers for shipping_freight sync (default: 15)');
  console.log('  --dry-run              Print sample payload only, do not send updates');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);

  if (!Number.isFinite(options.beatPercent) || options.beatPercent < 0 || options.beatPercent >= 100) {
    throw new Error('Invalid --beat-pct. Expected number >= 0 and < 100.');
  }

  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error('Invalid --batch-size. Expected integer >= 1.');
  }

  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error('Invalid --delay-ms. Expected integer >= 0.');
  }

  if (!Number.isInteger(options.websiteAssignmentConcurrency) || options.websiteAssignmentConcurrency < 1) {
    throw new Error('Invalid --website-assignment-concurrency. Expected integer >= 1.');
  }

  if (!Number.isInteger(options.shippingFreightConcurrency) || options.shippingFreightConcurrency < 1) {
    throw new Error('Invalid --shipping-freight-concurrency. Expected integer >= 1.');
  }

  if (!options.dryRun && !MAGENTO_CONFIG.token) {
    throw new Error('MAGENTO_KEY is required unless --dry-run is used');
  }

  const startedAt = Date.now();

  console.log('US Store Selected-Brand Quadratec-Retail Price Update');
  console.log(`Brands filter: ${options.brands.join(', ')}`);
  console.log(`Beat target: ${options.beatPercent}% below Quadratec retail`);
  console.log('Formula: round((retail * (1 - beat_pct/100)) / 0.85, 0) - 0.05');
  console.log(`Magento REST base: ${MAGENTO_CONFIG.baseURL}`);
  console.log(`BatchSize=${options.batchSize}, TimeoutMs=${MAGENTO_CONFIG.timeout}`);

  const {
    rows,
    scanned,
    skippedBrandMismatch,
    skippedMissingRetail,
    skippedInvalidPrice,
    rowsWithFinalMargin,
    avgFinalMargin,
    minFinalMargin,
    maxFinalMargin,
    minMarginFloorAppliedCount,
    minPriceFloorAppliedCount,
    byBrand,
  } = await getSelectedBrandRows(options.brands, options.beatPercent, options.limit);

  console.log(`Products scanned: ${scanned}`);
  console.log(`Price rows prepared: ${rows.length}`);
  console.log(`Skipped (brand mismatch): ${skippedBrandMismatch}`);
  console.log(`Skipped (missing Quadratec retail): ${skippedMissingRetail}`);
  console.log(`Skipped (invalid computed price): ${skippedInvalidPrice}`);
  console.log(`Min-margin floor applied: ${minMarginFloorAppliedCount}`);
  console.log(`Min-price floor applied (${MIN_PRICE_USD.toFixed(2)}): ${minPriceFloorAppliedCount}`);
  console.log(`Rows with final margin: ${rowsWithFinalMargin}`);
  if (rowsWithFinalMargin > 0) {
    console.log(`Final margin avg/min/max: ${avgFinalMargin} / ${minFinalMargin} / ${maxFinalMargin}`);
  }
  if (byBrand.length > 0) {
    console.log('Selected SKUs by brand:', byBrand);
  }

  if (rows.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  if (options.dryRun) {
    console.log('Dry run mode enabled. No Magento API calls sent.');
    console.log('Sample (20) SKUs to update:', rows.slice(0, 20));
    return;
  }

  if (options.skipWebsiteAssignment) {
    console.log('Skipping US website assignment sync (--skip-website-assignment).');
  } else {
    console.log(
      `Starting US website assignment sync for ${rows.length} SKUs (concurrency: ${options.websiteAssignmentConcurrency})...`
    );
    const websiteSyncStartedAt = Date.now();

    const websiteSync = await ensureUsWebsiteAssignmentForSkus({
      skus: rows.map((row) => row.sku),
      websiteId: STORE_ID_US,
      magentoConfig: MAGENTO_CONFIG,
      concurrency: options.websiteAssignmentConcurrency,
    });

    const websiteSyncElapsedSeconds = ((Date.now() - websiteSyncStartedAt) / 1000).toFixed(1);

    console.log('US website assignment sync:', {
      total: websiteSync.total,
      assigned: websiteSync.assigned,
      alreadyAssigned: websiteSync.alreadyAssigned,
      missingInMagento: websiteSync.missingInMagento,
      failed: websiteSync.failed,
      accessDeniedFailures: websiteSync.accessDeniedFailures,
      aborted: websiteSync.aborted,
      abortReason: websiteSync.abortReason,
      elapsedSeconds: websiteSyncElapsedSeconds,
    });
    if (websiteSync.failedSamples.length > 0) {
      console.log('Website assignment failure samples:', websiteSync.failedSamples);
    }

    if (websiteSync.aborted) {
      throw new Error(websiteSync.abortReason || 'Website assignment sync aborted');
    }
  }

  if (options.skipShippingFreightSync) {
    console.log('Skipping shipping_freight sync (--skip-shipping-freight-sync).');
  } else {
    console.log(
      `Starting shipping_freight sync for ${rows.length} SKUs (concurrency: ${options.shippingFreightConcurrency})...`
    );
    const shippingSyncStartedAt = Date.now();
    const shippingSync = await syncShippingFreightForRows(rows, options.shippingFreightConcurrency);
    const shippingSyncElapsedSeconds = ((Date.now() - shippingSyncStartedAt) / 1000).toFixed(1);

    console.log('shipping_freight sync:', {
      considered: shippingSync.considered,
      queued: shippingSync.queued,
      skippedMissingSurcharge: shippingSync.skippedMissingSurcharge,
      updated: shippingSync.updated,
      failed: shippingSync.failed,
      accessDeniedFailures: shippingSync.accessDeniedFailures,
      aborted: shippingSync.aborted,
      abortReason: shippingSync.abortReason,
      elapsedSeconds: shippingSyncElapsedSeconds,
    });

    if (shippingSync.failedSamples.length > 0) {
      console.log('shipping_freight failure samples:', shippingSync.failedSamples);
    }

    if (shippingSync.aborted) {
      throw new Error(shippingSync.abortReason || 'shipping_freight sync aborted');
    }
  }

  const batches = chunk(rows, options.batchSize);
  let sent = 0;
  let failedBatches = 0;
  let aborted = false;
  let abortReason = null;
  const liveUpdatedSamples = [];

  for (let i = 0; i < batches.length && !aborted; i++) {
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
        `Batch ${i + 1}/${batches.length} sent (${prices.length} SKUs) | HTTP ${response.status}`
      );
    } catch (error) {
      failedBatches++;
      const status = error.response?.status || 'ERR';
      const details = JSON.stringify(error.response?.data || error.message).slice(0, 400);
      console.log(`Batch ${i + 1}/${batches.length} failed | ${status} ${details}`);

      if (isAccessDeniedError(error)) {
        aborted = true;
        abortReason = 'Aborted price batches after Magento/Sucuri access denied response. Retry later or lower batch size/delay.';
        console.log(abortReason);
      }
    }

    if (i + 1 < batches.length && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\nJob complete');
  console.log(`  - Total prepared: ${rows.length}`);
  console.log(`  - Total sent: ${sent}`);
  console.log(`  - Failed batches: ${failedBatches}`);
  console.log(`  - Aborted: ${aborted}`);
  if (abortReason) {
    console.log(`  - Abort reason: ${abortReason}`);
  }
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
