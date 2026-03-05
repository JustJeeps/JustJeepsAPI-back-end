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
const prisma = require('../../../lib/prisma');

// Magento API Configuration
const MAGENTO_CONFIG = {
  baseURL: 'https://www.justjeeps.com/rest/default/V1',
  token: 'y6hyef5lqs7c94f43sui1vhb38693zy4',
  storeId: 1,
  timeout: 10000
};

/**
 * Predefined vendor configurations for seeding
 */
const VENDOR_CONFIGS = {
  'priority': [
    { name: 'Omix', batch: 100, concurrency: 10 },
    { name: 'AEV', batch: 75, concurrency: 8 },
    { name: 'Rough Country', batch: 100, concurrency: 250 },
    { name: 'MetalCloak', batch: 75, concurrency: 8 },
    { name: 'KeyParts', batch: 50, concurrency: 8 }
  ],
  // 'all': [
  //   { name: 'AEV', batch: 75, concurrency: 8 },
  //   { name: 'Rough Country', batch: 100, concurrency: 10 },
  //   { name: 'MetalCloak', batch: 75, concurrency: 8 },
  //   { name: 'Omix', batch: 100, concurrency: 10 },
  //   { name: 'KeyParts', batch: 50, concurrency: 8 },
  //   { name: 'Alpine', batch: 50, concurrency: 5 },
  //   { name: 'CTP', batch: 200, concurrency: 15 },
  //   { name: 'Curt', batch: 150, concurrency: 12 },
  //   { name: 'Downsview', batch: 75, concurrency: 8 },
  //   { name: 'Keystone', batch: 200, concurrency: 15 },
  //   { name: 'Meyer', batch: 200, concurrency: 15 },
  //   { name: 'Quadratec', batch: 200, concurrency: 15 },
  //   { name: 'T14', batch: 150, concurrency: 12 },
  //   { name: 'Tire Discounter', batch: 75, concurrency: 8 },
  //   { name: 'WheelPros', batch: 100, concurrency: 10 }
  // ]
};

/**
 * Update a single product in Magento
 */
async function updateMagentoProduct(sku, vendorCost, vendorInventory, vendorName) {
  try {
    const costUSD = (parseFloat(vendorCost) / 1.50).toFixed(2);
    
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
      const response = await axios.put(
        `${MAGENTO_CONFIG.baseURL}/products/${encodeURIComponent(sku)}?storeId=${MAGENTO_CONFIG.storeId}`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${MAGENTO_CONFIG.token}`,
            'Content-Type': 'application/json'
          },
          timeout: MAGENTO_CONFIG.timeout
        }
      );
      return { success: true, sku, response: response.status, method: 'PUT' };
    } catch (putError) {
      // If PUT fails with Method Not Allowed, try POST
      if (putError.response?.status === 405) {
        const postResponse = await axios.post(
          `${MAGENTO_CONFIG.baseURL}/products/${encodeURIComponent(sku)}?storeId=${MAGENTO_CONFIG.storeId}`,
          payload,
          {
            headers: {
              'Authorization': `Bearer ${MAGENTO_CONFIG.token}`,
              'Content-Type': 'application/json'
            },
            timeout: MAGENTO_CONFIG.timeout
          }
        );
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
        inventoryValue,
        product.vendor_name
      );
    });

    const chunkResults = await Promise.all(promises);
    
    chunkResults.forEach(result => {
      if (result.success) {
        results.successful++;
        console.log(`  ✅ ${result.sku}`);
      } else {
        results.failed++;
        results.errors.push(result);
        console.log(`  ❌ ${result.sku}: ${JSON.stringify(result.error).substring(0, 100)}`);
      }
    });

    // Rate limiting between chunks
    if (i + concurrency < products.length) {
      console.log('⏳ Waiting 1 second before next chunk...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  results.successRate = ((results.successful / products.length) * 100).toFixed(1);
  return results;
}

/**
 * Get vendor products for seeding
 */
async function getVendorProducts(vendorName, limit = null, offset = 0) {
  try {
    const vendor = await prisma.vendor.findFirst({
      where: { name: { contains: vendorName, mode: 'insensitive' } }
    });

    if (!vendor) {
      throw new Error(`Vendor '${vendorName}' not found`);
    }

    const products = await prisma.vendorProduct.findMany({
      where: {
        vendor_id: vendor.id,
        vendor_cost: { gt: 0 }
      },
      include: {
        product: {
          select: { sku: true }
        }
      },
      take: limit,
      skip: offset,
      orderBy: { id: 'asc' }
    });

    return products.map(vp => ({
      sku: vp.product.sku,
      vendor_cost: vp.vendor_cost,
      vendor_inventory: vp.vendor_inventory,
      vendor_inventory_string: vp.vendor_inventory_string,
      vendor_name: vendor.name
    }));
  } catch (error) {
    console.error(`❌ Error fetching ${vendorName} products:`, error.message);
    return [];
  }
}

/**
 * Seed a single vendor
 */
async function seedVendor(vendorName, batchSize = 100, concurrency = 10, maxProducts = null) {
  const startTime = Date.now();
  console.log(`\n🚀 Starting Magento attribute seeding for ${vendorName}`);
  console.log(`📊 Batch size: ${batchSize}, Concurrency: ${concurrency}, Max products: ${maxProducts || 'all'}`);

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
    let offset = 0;

    const processingLimit = maxProducts || totalVendorProducts;

    while (totalProcessed < processingLimit) {
      const remainingProducts = processingLimit - totalProcessed;
      const currentBatchSize = Math.min(batchSize, remainingProducts);

      console.log(`\n📦 Fetching batch ${Math.floor(offset/batchSize) + 1} (${currentBatchSize} products, offset: ${offset})`);
      
      const products = await getVendorProducts(vendorName, currentBatchSize, offset);
      
      if (products.length === 0) {
        console.log('No more products to process');
        break;
      }

      // Process the batch
      const batchStartTime = Date.now();
      const batchResult = await parallelUpdateMagentoProducts(products, concurrency);
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
      offset += products.length;

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
        await new Promise(resolve => setTimeout(resolve, 2000));
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
}

/**
 * Test seeding with a small number of products
 */
async function testSeed(vendorName, testSize = 5) {
  console.log(`🧪 Testing ${vendorName} seeding with ${testSize} products...`);
  
  const products = await getVendorProducts(vendorName, testSize, 0);
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

  try {
    switch (command) {
      case 'all':
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