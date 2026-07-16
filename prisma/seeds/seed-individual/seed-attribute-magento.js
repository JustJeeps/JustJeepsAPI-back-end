#!/usr/bin/env node

/**
 * Magento Attribute Seeder - Multi-Vendor Cost & Inventory Updates
 * 
 * This script seeds Magento products with cost_usd and inventory_vendor attributes
 * from vendor data in the database. Supports all vendors with parallel processing.
 * 
 * Usage:
 *   node prisma/seeds/seed-individual/seed-attribute-magento.js all
 *   node prisma/seeds/seed-individual/seed-attribute-magento.js vendor "AEV"
 *   node prisma/seeds/seed-individual/seed-attribute-magento.js test "AEV" 5
 */

const axios = require('axios');
const https = require('https');
const prisma = require('../../../lib/prisma');
const { USD_TO_CAD_RATE } = require('../../../utils/exchangeRate');

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeThrottleTelemetry(concurrency, chunkDelayMs) {
  const minimumSecondsPerChunk = Math.max(chunkDelayMs, 1) / 1000;
  const theoreticalMaxPerSecond = concurrency / minimumSecondsPerChunk;
  const theoreticalMaxPerMinute = theoreticalMaxPerSecond * 60;

  return {
    minimumSecondsPerChunk,
    theoreticalMaxPerSecond,
    theoreticalMaxPerMinute,
  };
}

// Magento API Configuration
const MAGENTO_CONFIG = {
  baseURL: 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY || process.env.MAGENTO_TOKEN || '',
  storeId: toPositiveInt(process.env.MAGENTO_STORE_ID, 1),
  timeout: toPositiveInt(process.env.MAGENTO_TIMEOUT_MS, 10000),
  maxRetries: toPositiveInt(process.env.MAGENTO_MAX_RETRIES, 3),
  retryDelayMs: toPositiveInt(process.env.MAGENTO_RETRY_DELAY_MS, 500),
  chunkDelayMs: toPositiveInt(process.env.MAGENTO_CHUNK_DELAY_MS, 1000),
  batchDelayMs: toPositiveInt(process.env.MAGENTO_BATCH_DELAY_MS, 2000),
  maxSafeConcurrency: toPositiveInt(process.env.MAGENTO_MAX_SAFE_CONCURRENCY, 12),
  maxSafeBatchSize: toPositiveInt(process.env.MAGENTO_MAX_SAFE_BATCH_SIZE, 150),
  httpsMaxSockets: toPositiveInt(process.env.MAGENTO_HTTPS_MAX_SOCKETS, 25)
};

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAGENTO_CONFIG.httpsMaxSockets,
});
const magentoClient = axios.create({
  baseURL: MAGENTO_CONFIG.baseURL,
  timeout: MAGENTO_CONFIG.timeout,
  httpsAgent,
  headers: {
    'Authorization': `Bearer ${MAGENTO_CONFIG.token}`,
    'Content-Type': 'application/json'
  }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function createRequestMetrics() {
  return {
    startedAt: Date.now(),
    totalHttpRequests: 0,
    totalRetries: 0,
    totalFallbackPosts: 0,
    statusCounts: {},
    byMethod: {
      put: 0,
      post: 0,
    },
    increment(method, statusCode) {
      const normalizedMethod = String(method || '').toLowerCase();
      if (normalizedMethod === 'put' || normalizedMethod === 'post') {
        this.byMethod[normalizedMethod] += 1;
      }
      this.totalHttpRequests += 1;
      const statusKey = String(statusCode ?? 'unknown');
      this.statusCounts[statusKey] = (this.statusCounts[statusKey] || 0) + 1;
    },
    report(label) {
      const elapsedSeconds = Math.max((Date.now() - this.startedAt) / 1000, 1);
      const reqPerMinute = this.totalHttpRequests / (elapsedSeconds / 60);
      const statusSummary = Object.entries(this.statusCounts)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([status, count]) => `${status}:${count}`)
        .join(', ');

      console.log(`📡 HTTP Metrics (${label}):`);
      console.log(`   - Total Magento HTTP requests: ${this.totalHttpRequests}`);
      console.log(`   - HTTP request rate: ${reqPerMinute.toFixed(2)} requests/min`);
      console.log(`   - PUT requests: ${this.byMethod.put}`);
      console.log(`   - POST fallback requests: ${this.byMethod.post}`);
      console.log(`   - Retry attempts: ${this.totalRetries}`);
      console.log(`   - PUT->POST fallback count: ${this.totalFallbackPosts}`);
      if (statusSummary) {
        console.log(`   - Status breakdown: ${statusSummary}`);
      }
    },
  };
}

const requestMetrics = createRequestMetrics();

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

async function magentoRequestWithRetry(method, sku, payload) {
  let lastError;

  for (let attempt = 1; attempt <= MAGENTO_CONFIG.maxRetries; attempt++) {
    try {
      const response = await magentoClient.request({
        method,
        url: `/products/${encodeURIComponent(sku)}`,
        params: { storeId: MAGENTO_CONFIG.storeId },
        data: payload
      });
      requestMetrics.increment(method, response.status);
      return response;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      requestMetrics.increment(method, status);
      if (attempt === MAGENTO_CONFIG.maxRetries || !isRetryableStatus(status)) {
        throw error;
      }

      requestMetrics.totalRetries += 1;
      const delay = MAGENTO_CONFIG.retryDelayMs * attempt;
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Predefined vendor configurations for seeding
 */
const VENDOR_CONFIGS = {
  'priority': [
    { name: 'Omix', batch: 100, concurrency: 10 },
    { name: 'AEV', batch: 75, concurrency: 8 },
    { name: 'Rough Country', batch: 100, concurrency: 10 },
    { name: 'MetalCloak', batch: 75, concurrency: 8 },
    { name: 'KeyParts', batch: 50, concurrency: 8 }
  ],
  'all': [
    { name: 'AEV', batch: 75, concurrency: 8 },
    { name: 'Rough Country', batch: 100, concurrency: 10 },
    { name: 'MetalCloak', batch: 75, concurrency: 8 },
    { name: 'Omix', batch: 100, concurrency: 10 },
    { name: 'KeyParts', batch: 50, concurrency: 8 },
    { name: 'Alpine', batch: 50, concurrency: 5 },
    { name: 'CTP', batch: 200, concurrency: 15 },
    { name: 'Curt', batch: 150, concurrency: 12 },
    { name: 'Downsview', batch: 75, concurrency: 8 },
    { name: 'Keystone', batch: 200, concurrency: 15 },
    { name: 'Meyer', batch: 200, concurrency: 15 },
    { name: 'Quadratec', batch: 200, concurrency: 15 },
    { name: 'T14', batch: 150, concurrency: 12 },
    { name: 'Tire Discounter', batch: 75, concurrency: 8 },
    { name: 'WheelPros', batch: 100, concurrency: 10 }
  ]
};

/**
 * Update a single product in Magento
 */
async function updateMagentoProduct(sku, vendorCost, vendorInventory) {
  try {
    const costUSD = (parseFloat(vendorCost) / USD_TO_CAD_RATE).toFixed(2);
    
    const payload = {
      product: {
        sku: sku,
        custom_attributes: [
          {
            attribute_code: 'cost_usd',
            value: costUSD
          },
          {
            attribute_code: 'inventory_vendor',
            value: vendorInventory.toString()
          }
        ]
      }
    };

    // Try PUT first (standard method)
    try {
      const response = await magentoRequestWithRetry('put', sku, payload);
      return { success: true, sku, response: response.status, method: 'PUT' };
    } catch (putError) {
      // If PUT fails with Method Not Allowed, try POST
      if (putError.response?.status === 405) {
        requestMetrics.totalFallbackPosts += 1;
        const postResponse = await magentoRequestWithRetry('post', sku, payload);
        return { success: true, sku, response: postResponse.status, method: 'POST' };
      }
      throw putError;
    }

  } catch (error) {
    return {
      success: false,
      sku,
      error: error.response?.data || error.message,
      status: error.response?.status
    };
  }
}

/**
 * Process products in parallel chunks
 */
async function parallelUpdateMagentoProducts(products, concurrency = 10) {
  const results = { successful: 0, failed: 0, errors: [] };
  
  // Process in chunks to avoid overwhelming the API
  for (let i = 0; i < products.length; i += concurrency) {
    const chunk = products.slice(i, i + concurrency);
    console.log(`📦 Processing chunk ${Math.floor(i/concurrency) + 1}/${Math.ceil(products.length/concurrency)} (${chunk.length} products)...`);
    
    const promises = chunk.map(product => {
      // Prefer vendor_inventory if present, else vendor_inventory_string, else 'NO INFO'
      // For Rough Country, treat numeric zero inventory as a fallback case to inventory string.
      let inventoryValue = product.vendor_inventory;
      const isRoughCountryVendor =
        typeof product.vendor_name === 'string' &&
        product.vendor_name.toLowerCase().includes('rough country');

      if (inventoryValue === null || inventoryValue === undefined) {
        inventoryValue = product.vendor_inventory_string || 'NO INFO';
      } else if (
        isRoughCountryVendor &&
        Number(inventoryValue) === 0 &&
        product.vendor_inventory_string
      ) {
        inventoryValue = product.vendor_inventory_string;
      }
      return updateMagentoProduct(
        product.sku,
        product.vendor_cost,
        inventoryValue
      );
    });

    const chunkResults = await Promise.all(promises);
    let chunkSuccess = 0;
    let chunkFailed = 0;
    
    chunkResults.forEach(result => {
      if (result.success) {
        results.successful++;
        chunkSuccess++;
      } else {
        results.failed++;
        chunkFailed++;
        results.errors.push(result);
      }
    });

    console.log(`   ✅ Chunk success: ${chunkSuccess} | ❌ Chunk failed: ${chunkFailed}`);
    if (chunkFailed > 0) {
      const sampleErrors = chunkResults.filter(r => !r.success).slice(0, 3);
      sampleErrors.forEach((errorResult) => {
        console.log(`   ❌ ${errorResult.sku}: ${JSON.stringify(errorResult.error).substring(0, 120)}`);
      });
    }

    // Rate limiting between chunks
    if (i + concurrency < products.length) {
      console.log('⏳ Waiting 1 second before next chunk...');
      await sleep(MAGENTO_CONFIG.chunkDelayMs);
    }
  }

  results.successRate = ((results.successful / products.length) * 100).toFixed(1);
  return results;
}

/**
 * Get vendor products for seeding
 */
async function getVendorProducts(vendor, limit = null, lastSeenId = 0) {
  try {
    const products = await prisma.vendorProduct.findMany({
      where: {
        vendor_id: vendor.id,
        id: { gt: lastSeenId },
        vendor_cost: { gt: 0 }
      },
      include: {
        product: {
          select: { sku: true }
        }
      },
      take: limit,
      orderBy: { id: 'asc' }
    });

    return products.map(vp => ({
      id: vp.id,
      sku: vp.product.sku,
      vendor_cost: vp.vendor_cost,
      vendor_inventory: vp.vendor_inventory,
      vendor_inventory_string: vp.vendor_inventory_string,
      vendor_name: vendor.name
    }));
  } catch (error) {
    console.error(`❌ Error fetching ${vendor.name} products:`, error.message);
    return [];
  }
}

/**
 * Seed a single vendor
 */
async function seedVendor(vendorName, batchSize = 100, concurrency = 10, maxProducts = null) {
  const startTime = Date.now();
  const safeBatchSize = Math.max(1, Math.min(batchSize, MAGENTO_CONFIG.maxSafeBatchSize));
  const safeConcurrency = Math.max(1, Math.min(concurrency, MAGENTO_CONFIG.maxSafeConcurrency));
  const throttleTelemetry = computeThrottleTelemetry(safeConcurrency, MAGENTO_CONFIG.chunkDelayMs);

  if (safeBatchSize !== batchSize) {
    console.log(`⚠️  Batch size ${batchSize} reduced to safe limit ${safeBatchSize}.`);
  }
  if (safeConcurrency !== concurrency) {
    console.log(`⚠️  Concurrency ${concurrency} reduced to safe limit ${safeConcurrency}.`);
  }

  console.log(`\n🚀 Starting Magento attribute seeding for ${vendorName}`);
  console.log(`📊 Batch size: ${safeBatchSize}, Concurrency: ${safeConcurrency}, Max products: ${maxProducts || 'all'}`);
  console.log(`⚙️  Effective throttle: chunkDelay=${MAGENTO_CONFIG.chunkDelayMs}ms, batchDelay=${MAGENTO_CONFIG.batchDelayMs}ms, retries=${MAGENTO_CONFIG.maxRetries}, httpsMaxSockets=${MAGENTO_CONFIG.httpsMaxSockets}`);
  console.log(`🎯 Estimated max rate (delay-only): ${throttleTelemetry.theoreticalMaxPerSecond.toFixed(2)} products/sec (${throttleTelemetry.theoreticalMaxPerMinute.toFixed(0)} products/min)`);

  try {
    // Get vendor info and total count
    const vendor = await prisma.vendor.findFirst({
      where: { name: { contains: vendorName, mode: 'insensitive' } }
    });

    if (!vendor) {
      throw new Error(`Vendor '${vendorName}' not found`);
    }

    const totalVendorProducts = await prisma.vendorProduct.count({
      where: { vendor_id: vendor.id, vendor_cost: { gt: 0 } }
    });

    console.log(`📋 Found ${totalVendorProducts} ${vendorName} products with valid costs`);

    if (totalVendorProducts === 0) {
      console.log(`⚠️  No products found for ${vendorName} with valid costs`);
      return;
    }

    let totalProcessed = 0;
    let totalSuccessful = 0;
    let totalFailed = 0;
    let lastSeenId = 0;

    const processingLimit = maxProducts || totalVendorProducts;

    while (totalProcessed < processingLimit) {
      const remainingProducts = processingLimit - totalProcessed;
      const currentBatchSize = Math.min(safeBatchSize, remainingProducts);

      console.log(`\n📦 Fetching batch ${Math.floor(totalProcessed / safeBatchSize) + 1} (${currentBatchSize} products, last id: ${lastSeenId})`);
      
      const products = await getVendorProducts(vendor, currentBatchSize, lastSeenId);
      
      if (products.length === 0) {
        console.log('No more products to process');
        break;
      }

      if (products.length > 0) {
        lastSeenId = products[products.length - 1].id;
      }

      // Process the batch
      const batchStartTime = Date.now();
      const batchResult = await parallelUpdateMagentoProducts(products, safeConcurrency);
      const batchEndTime = Date.now();
      const batchDuration = (batchEndTime - batchStartTime) / 1000;

      console.log(`\n📊 Batch completed in ${batchDuration.toFixed(1)}s:`);
      console.log(`   - Successful: ${batchResult.successful}`);
      console.log(`   - Failed: ${batchResult.failed}`);
      console.log(`   - Success rate: ${batchResult.successRate}%`);
      console.log(`   - Throughput: ${(batchResult.successful / batchDuration).toFixed(1)} products/second`);

      totalSuccessful += batchResult.successful;
      totalFailed += batchResult.failed;
      totalProcessed += products.length;

      // Progress tracking
      const elapsedTime = (Date.now() - startTime) / 1000;
      const avgThroughput = totalProcessed / elapsedTime;
      const estimatedTimeRemaining = (processingLimit - totalProcessed) / avgThroughput;

      console.log(`\n📊 Overall Progress for ${vendorName}:`);
      console.log(`   - Processed: ${totalProcessed}/${processingLimit}, Successful: ${totalSuccessful}, Failed: ${totalFailed}`);
      console.log(`   - Elapsed: ${elapsedTime.toFixed(0)}s, Avg throughput: ${avgThroughput.toFixed(1)} products/sec`);
      if (totalProcessed < processingLimit) {
        console.log(`   - Estimated time remaining: ${(estimatedTimeRemaining / 60).toFixed(1)} minutes`);
      }

      // Wait between batches
      if (totalProcessed < processingLimit) {
        console.log('⏳ Waiting 2 seconds before next batch...');
        await sleep(MAGENTO_CONFIG.batchDelayMs);
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\n🎉 ${vendorName} seeding completed!`);
    console.log(`📊 Final Results:`);
    console.log(`   - Total processed: ${totalProcessed}`);
    console.log(`   - Successful: ${totalSuccessful}`);
    console.log(`   - Failed: ${totalFailed}`);
    console.log(`   - Success rate: ${((totalSuccessful / totalProcessed) * 100).toFixed(1)}%`);
    console.log(`   - Total time: ${(totalTime / 60).toFixed(1)} minutes`);
    console.log(`   - Average throughput: ${(totalProcessed / totalTime).toFixed(1)} products/second`);

  } catch (error) {
    console.error(`❌ Error seeding ${vendorName}:`, error.message);
  }
}

/**
 * Seed multiple vendors sequentially
 */
async function seedMultipleVendors(vendorConfigs) {
  const overallStartTime = Date.now();
  console.log(`🌟 Starting multi-vendor Magento attribute seeding`);
  console.log(`📋 Vendors to process: ${vendorConfigs.map(v => v.name).join(', ')}`);

  let overallStats = {
    vendors: 0,
    totalProducts: 0,
    totalSuccessful: 0,
    totalFailed: 0
  };

  for (const config of vendorConfigs) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📦 VENDOR ${overallStats.vendors + 1}/${vendorConfigs.length}: ${config.name.toUpperCase()}`);
    console.log(`${'='.repeat(60)}`);

    await seedVendor(config.name, config.batch, config.concurrency);
    overallStats.vendors++;

    // Small delay between vendors
    if (overallStats.vendors < vendorConfigs.length) {
      console.log('\n⏳ Waiting 5 seconds before next vendor...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  const overallTime = (Date.now() - overallStartTime) / 1000;
  console.log(`\n${'🎉'.repeat(20)}`);
  console.log(`🎉 ALL VENDORS SEEDING COMPLETED! 🎉`);
  console.log(`${'🎉'.repeat(20)}`);
  console.log(`📊 Overall Results:`);
  console.log(`   - Vendors processed: ${overallStats.vendors}`);
  console.log(`   - Total time: ${(overallTime / 60).toFixed(1)} minutes`);
  console.log(`   - Completed at: ${new Date().toLocaleString()}`);
  requestMetrics.report('all vendors');
}

/**
 * Test seeding with a small number of products
 */
async function testSeed(vendorName, testSize = 5) {
  console.log(`🧪 Testing ${vendorName} seeding with ${testSize} products...`);

  const vendor = await prisma.vendor.findFirst({
    where: { name: { contains: vendorName, mode: 'insensitive' } }
  });
  if (!vendor) {
    console.log(`❌ Vendor '${vendorName}' not found`);
    return;
  }
  
  const products = await getVendorProducts(vendor, testSize, 0);
  if (products.length === 0) {
    console.log(`❌ No products found for ${vendorName}`);
    return;
  }

  console.log(`🎯 Testing with ${products.length} products:`);
  products.forEach(product => {
    console.log(`   - ${product.sku}: cost=${product.vendor_cost}, inventory=${product.vendor_inventory}`);
  });

  const startTime = Date.now();
  const result = await parallelUpdateMagentoProducts(products, 3);
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log(`\n📊 Test Results:`);
  console.log(`   - Duration: ${duration.toFixed(1)}s`);
  console.log(`   - Successful: ${result.successful}`);
  console.log(`   - Failed: ${result.failed}`);
  console.log(`   - Success rate: ${result.successRate}%`);
  requestMetrics.report(`test ${vendorName}`);
}

/**
 * List available vendors for seeding
 */
async function listVendors() {
  try {
    console.log('📋 Available vendors for Magento attribute seeding:');
    
    const vendors = await prisma.vendor.findMany({
      orderBy: { name: 'asc' }
    });

    console.log('\n🏆 Priority Vendors (recommended for overnight seeding):');
    for (const config of VENDOR_CONFIGS.priority) {
      const vendor = vendors.find(v => v.name.toLowerCase().includes(config.name.toLowerCase()));
      if (vendor) {
        const productCount = await prisma.vendorProduct.count({
          where: {
            vendor_id: vendor.id,
            vendor_cost: { gt: 0 }
          }
        });
        console.log(`   - ${config.name}: ${productCount} products (batch: ${config.batch}, concurrency: ${config.concurrency})`);
      }
    }

    console.log('\n📊 All Vendors:');
    for (const vendor of vendors) {
      const productCount = await prisma.vendorProduct.count({
        where: {
          vendor_id: vendor.id,
          vendor_cost: { gt: 0 }
        }
      });
      
      if (productCount > 0) {
        console.log(`   - ${vendor.name}: ${productCount} products`);
      }
    }

  } catch (error) {
    console.error('❌ Error listing vendors:', error);
  }
}

// Command-line interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!MAGENTO_CONFIG.token) {
    console.error('❌ MAGENTO_KEY (or MAGENTO_TOKEN) is required. Export it before running this script.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'all':
        if (!Array.isArray(VENDOR_CONFIGS.all) || VENDOR_CONFIGS.all.length === 0) {
          throw new Error('VENDOR_CONFIGS.all is not configured');
        }
        await seedMultipleVendors(VENDOR_CONFIGS.all);
        break;
        
      case 'priority':
        await seedMultipleVendors(VENDOR_CONFIGS.priority);
        break;
        
      case 'vendor':
        const vendorName = args[1];
        if (!vendorName) {
          console.error('❌ Error: Vendor name is required');
          console.log('Usage: node prisma/seeds/seed-individual/seed-attribute-magento.js vendor "<vendor-name>"');
          process.exit(1);
        }
        const batchSize = parseInt(args[2]) || 100;
        const concurrency = parseInt(args[3]) || 10;
        const maxProducts = parseInt(args[4]) || null;
        await seedVendor(vendorName, batchSize, concurrency, maxProducts);
        break;
        
      case 'test':
        const testVendor = args[1] || 'AEV';
        const testSize = parseInt(args[2]) || 5;
        await testSeed(testVendor, testSize);
        break;
        
      case 'list':
        await listVendors();
        break;
        
      default:
        console.log('🌱 Magento Attribute Seeder');
        console.log('');
        console.log('Commands:');
        console.log('  list                                     List available vendors');
        console.log('  priority                                 Seed priority vendors (overnight batch)');
        console.log('  all                                      Seed all vendors');
        console.log('  vendor "<name>" [batch] [conc] [max]     Seed specific vendor');
        console.log('  test [vendor] [size]                     Test with sample products');
        console.log('');
        console.log('Examples:');
        console.log('  node prisma/seeds/seed-individual/seed-attribute-magento.js list');
        console.log('  node prisma/seeds/seed-individual/seed-attribute-magento.js priority');
        console.log('  node prisma/seeds/seed-individual/seed-attribute-magento.js vendor "AEV"');
        console.log('  node prisma/seeds/seed-individual/seed-attribute-magento.js test "MetalCloak" 3');
        console.log('');
        console.log('Priority Vendors (optimized for overnight):');
        console.log('  - AEV, Rough Country, MetalCloak, Omix, KeyParts');
        break;
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
  } finally {
    if (requestMetrics.totalHttpRequests > 0) {
      requestMetrics.report('run summary');
    }
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  seedVendor,
  seedMultipleVendors,
  testSeed,
  listVendors,
  VENDOR_CONFIGS
};