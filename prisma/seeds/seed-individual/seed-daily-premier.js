/**
 * Premier Performance Daily Seeding Script
 * Updates pricing and inventory for all products with premier_code
 */

require('dotenv').config();
const PremierService = require("../../../services/premier");

const prisma = require("../../../lib/prisma");

const EXCHANGE_RATE = 1.5;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_DB_WRITE_CONCURRENCY = 3;
const DEFAULT_FAILURE_BACKOFF_MS = 2000;
const DEFAULT_PRELOAD_CHUNK_SIZE = 5000;
const DEFAULT_PRICING_MAX_RETRIES = 2;
const DEFAULT_PRICING_RETRY_DELAY_MS = 1500;

const buildVendorProductKey = (productSku, vendorSku) => `${productSku}::${vendorSku}`;

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

const chunkArray = (items, chunkSize) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
};

const mapWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let currentIndex = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (currentIndex < items.length) {
        const index = currentIndex;
        currentIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
  return results;
};

const buildProductsByPremierCode = (products) => {
  const productsByPremierCode = new Map();

  for (const product of products) {
    if (!product.premier_code) {
      continue;
    }

    if (!productsByPremierCode.has(product.premier_code)) {
      productsByPremierCode.set(product.premier_code, []);
    }

    productsByPremierCode.get(product.premier_code).push(product);
  }

  return productsByPremierCode;
};

const preloadExistingVendorProducts = async ({ vendorId, premierCodes, chunkSize }) => {
  const chunks = chunkArray(premierCodes, chunkSize);
  const existingVendorProducts = [];

  for (const chunk of chunks) {
    const rows = await prisma.vendorProduct.findMany({
      where: {
        vendor_id: vendorId,
        vendor_sku: { in: chunk }
      },
      select: {
        id: true,
        product_sku: true,
        vendor_sku: true
      }
    });

    existingVendorProducts.push(...rows);
  }

  return existingVendorProducts;
};

const hasAnyPricingData = (results) => {
  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }

  return results.some(result => {
    const pricing = result?.pricing || {};
    return (pricing.cost || 0) > 0 || (pricing.jobber || 0) > 0 || (pricing.map || 0) > 0;
  });
};

const isRetryablePricingError = (message) => {
  if (!message) {
    return false;
  }

  return /(status code 500|status code 502|status code 503|status code 504|etimedout|econnreset|socket hang up|timeout|too many requests|status code 429)/i.test(message);
};

const getBatchProductInfoWithPricingRetry = async ({
  premier,
  batch,
  batchNum,
  totalBatches,
  maxRetries,
  retryDelayMs
}) => {
  let lastPricingError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptNumber = attempt + 1;

    if (attempt > 0) {
      console.log(`  Retrying batch ${batchNum}/${totalBatches} (attempt ${attemptNumber}/${maxRetries + 1}) after pricing failure...`);
    }

    const batchResult = await premier.getBatchProductInfo(batch);

    if (!batchResult.success) {
      const errorMessage = batchResult.error || '';

      if (isRetryablePricingError(errorMessage) && attempt < maxRetries) {
        await delay(retryDelayMs);
        continue;
      }

      return batchResult;
    }

    if (hasAnyPricingData(batchResult.results)) {
      return batchResult;
    }

    const pricingProbe = await premier.pricing.getBatchPricing(batch);
    if (pricingProbe.success) {
      return batchResult;
    }

    lastPricingError = pricingProbe.error || 'Unknown pricing error';

    if (isRetryablePricingError(lastPricingError) && attempt < maxRetries) {
      await delay(retryDelayMs);
      continue;
    }

    return {
      ...batchResult,
      success: false,
      error: `Pricing retry failed: ${lastPricingError}`
    };
  }

  return {
    success: false,
    results: [],
    error: `Pricing retry exhausted: ${lastPricingError || 'Unknown pricing error'}`
  };
};

const processBatchResult = async ({
  result,
  premierVendorId,
  productsByPremierCode,
  existingVendorProductsByKey
}) => {
  const summary = {
    totalProcessed: 1,
    successfulUpdates: 0,
    createdRecords: 0,
    updatedRecords: 0,
    skippedZeroCost: 0,
    errors: []
  };

  if (!result.success) {
    console.log(`  ⚠️ ${result.itemNumber}: ${result.errors.join(', ')}`);
    return summary;
  }

  const matchingProducts = productsByPremierCode.get(result.itemNumber) || [];

  if (matchingProducts.length === 0) {
    console.log(`  ⚠️ No product found with premier_code: ${result.itemNumber}`);
    return summary;
  }

  if (result.pricing.cost <= 0) {
    console.log(`  ⚠️ Skipped: ${result.itemNumber} - No pricing available (Cost: $0)`);
    summary.skippedZeroCost += 1;
    return summary;
  }

  const convertedCost = result.pricing.cost * EXCHANGE_RATE;

  for (const product of matchingProducts) {
    try {
      const vendorProductKey = buildVendorProductKey(product.sku, result.itemNumber);
      const existingVendorProduct = existingVendorProductsByKey.get(vendorProductKey);

      const vendorData = {
        product_sku: product.sku,
        vendor_id: premierVendorId,
        vendor_sku: result.itemNumber,
        vendor_cost: convertedCost,
        vendor_inventory: result.inventory.quantity || 0
      };

      if (existingVendorProduct) {
        await prisma.vendorProduct.update({
          where: { id: existingVendorProduct.id },
          data: {
            vendor_cost: convertedCost,
            vendor_inventory: vendorData.vendor_inventory
          }
        });
        summary.updatedRecords += 1;
        console.log(`  ✅ Updated: ${product.sku} -> ${result.itemNumber} - Cost: $${result.pricing.cost} → CAD $${convertedCost.toFixed(2)}, Qty: ${result.inventory.quantity}`);
      } else {
        const createdVendorProduct = await prisma.vendorProduct.create({
          data: vendorData
        });
        existingVendorProductsByKey.set(vendorProductKey, {
          id: createdVendorProduct.id,
          product_sku: product.sku,
          vendor_sku: result.itemNumber
        });
        summary.createdRecords += 1;
        console.log(`  ➕ Created: ${product.sku} -> ${result.itemNumber} - Cost: $${result.pricing.cost} → CAD $${convertedCost.toFixed(2)}, Qty: ${result.inventory.quantity}`);
      }
    } catch (error) {
      console.error(`  ❌ Error processing ${result.itemNumber}/${product.sku}:`, error.message);
      summary.errors.push(`${result.itemNumber}/${product.sku}: ${error.message}`);
    }
  }

  if (summary.createdRecords > 0 || summary.updatedRecords > 0) {
    summary.successfulUpdates += 1;
  }

  return summary;
};

const seedDailyPremierData = async () => {
  const startTime = Date.now();
  console.time("Premier Seed Duration");
  
  try {
    console.log("=== Premier Performance Daily Update Started ===\n");
    
    // Initialize Premier service
    const premier = new PremierService();
    
    // Test connection
    console.log("Testing Premier API connection...");
    const connectionTest = await premier.testConnection();
    if (!connectionTest.success) {
      throw new Error(`Premier API connection failed: ${connectionTest.message}`);
    }
    console.log("✅ Premier API connection successful\n");
    
    // Get or create Premier vendor in Vendor table
    console.log("Getting Premier vendor...");
    let premierVendor = await prisma.vendor.findFirst({
      where: { name: "Premier Performance" }
    });
    
    if (!premierVendor) {
      console.log("Creating Premier Performance vendor...");
      premierVendor = await prisma.vendor.create({
        data: {
          name: "Premier Performance",
          website: "https://premierwd.com",
          address: "Premier Performance Distribution",
          main_contact: "Premier Sales",
          username: "API",
          password: "API_ACCESS"
        }
      });
      console.log(`✅ Created Premier vendor with ID: ${premierVendor.id}`);
    } else {
      console.log(`✅ Found Premier vendor with ID: ${premierVendor.id}`);
    }
    
    // Get all products with Premier codes
    console.log("\nFetching products with Premier codes...");
    const productsWithPremierCodes = await prisma.product.findMany({
      where: {
        premier_code: {
          not: null,
          not: ""
        }
      },
      select: {
        sku: true,
        premier_code: true,
        brand_name: true,
        name: true
      }
    });
    
    console.log(`Found ${productsWithPremierCodes.length} products with Premier codes`);
    
    if (productsWithPremierCodes.length === 0) {
      console.log("No products with Premier codes found. Exiting.");
      return;
    }
    
    // Extract unique Premier codes and filter out invalid ones
    const allPremierCodes = [...new Set(productsWithPremierCodes.map(p => p.premier_code))];
    const productsByPremierCode = buildProductsByPremierCode(productsWithPremierCodes);
    
    // Filter out invalid codes (ending with dash, too short, etc.)
    const premierCodes = allPremierCodes.filter(code => {
      if (!code || code.length < 5) return false;           // Too short
      if (code.endsWith('-')) return false;                 // Incomplete code
      if (code.includes('--')) return false;                // Double dash
      return true;
    });
    
    console.log(`Found ${allPremierCodes.length} total codes, filtered to ${premierCodes.length} valid codes`);
    console.log(`Processing ${premierCodes.length} unique Premier codes\n`);
    let totalProcessed = 0;
    let successfulUpdates = 0;
    let createdRecords = 0;
    let updatedRecords = 0;
    let skippedZeroCost = 0;
    let errors = [];

    const batchSize = toPositiveInt(process.env.PREMIER_SEED_BATCH_SIZE, DEFAULT_BATCH_SIZE);
    const dbWriteConcurrency = toPositiveInt(process.env.PREMIER_SEED_DB_WRITE_CONCURRENCY, DEFAULT_DB_WRITE_CONCURRENCY);
    const failureBackoffMs = toPositiveInt(process.env.PREMIER_SEED_FAILURE_BACKOFF_MS, DEFAULT_FAILURE_BACKOFF_MS);
    const preloadChunkSize = toPositiveInt(process.env.PREMIER_SEED_PRELOAD_CHUNK_SIZE, DEFAULT_PRELOAD_CHUNK_SIZE);
    const pricingMaxRetries = toPositiveInt(process.env.PREMIER_SEED_PRICING_MAX_RETRIES, DEFAULT_PRICING_MAX_RETRIES);
    const pricingRetryDelayMs = toPositiveInt(process.env.PREMIER_SEED_PRICING_RETRY_DELAY_MS, DEFAULT_PRICING_RETRY_DELAY_MS);

    console.log(`Using Premier batch size: ${batchSize}`);
    console.log(`Using DB write concurrency: ${dbWriteConcurrency}`);
    console.log(`Using preload chunk size: ${preloadChunkSize}\n`);
    console.log(`Using pricing max retries: ${pricingMaxRetries}`);
    console.log(`Using pricing retry delay: ${pricingRetryDelayMs}ms\n`);

    console.log("Preloading existing Premier vendor product links...");
    const existingVendorProducts = await preloadExistingVendorProducts({
      vendorId: premierVendor.id,
      premierCodes,
      chunkSize: preloadChunkSize
    });

    const existingVendorProductsByKey = new Map(
      existingVendorProducts.map(vendorProduct => [
        buildVendorProductKey(vendorProduct.product_sku, vendorProduct.vendor_sku),
        vendorProduct
      ])
    );

    console.log(`Preloaded ${existingVendorProducts.length} existing Premier vendor product records\n`);
    
    for (let i = 0; i < premierCodes.length; i += batchSize) {
      const batch = premierCodes.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(premierCodes.length / batchSize);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);
      
      try {
        // Get batch data from Premier API with retry on transient pricing failures.
        const batchResult = await getBatchProductInfoWithPricingRetry({
          premier,
          batch,
          batchNum,
          totalBatches,
          maxRetries: pricingMaxRetries,
          retryDelayMs: pricingRetryDelayMs
        });
        
        if (!batchResult.success) {
          console.error(`Batch ${batchNum} failed:`, batchResult.error);
          errors.push(`Batch ${batchNum}: ${batchResult.error}`);
          console.log(`  Backing off for ${failureBackoffMs}ms before continuing...\n`);
          await delay(failureBackoffMs);
          continue;
        }
        
        const batchSummaries = await mapWithConcurrency(
          batchResult.results,
          dbWriteConcurrency,
          (result) => processBatchResult({
            result,
            premierVendorId: premierVendor.id,
            productsByPremierCode,
            existingVendorProductsByKey
          })
        );

        for (const summary of batchSummaries) {
          totalProcessed += summary.totalProcessed;
          successfulUpdates += summary.successfulUpdates;
          createdRecords += summary.createdRecords;
          updatedRecords += summary.updatedRecords;
          skippedZeroCost += summary.skippedZeroCost;
          errors.push(...summary.errors);
        }
      } catch (error) {
        console.error(`Batch ${batchNum} processing error:`, error.message);
        errors.push(`Batch ${batchNum}: ${error.message}`);
        console.log(`  Backing off for ${failureBackoffMs}ms before continuing...\n`);
        await delay(failureBackoffMs);
      }
    }
    
    // Summary
    console.log("\n=== Premier Performance Update Summary ===");
    console.log(`Total Premier codes processed: ${totalProcessed}`);
    console.log(`Items with pricing (processed): ${successfulUpdates}`);
    console.log(`Items without pricing (skipped): ${skippedZeroCost}`);
    console.log(`New records created: ${createdRecords}`);
    console.log(`Existing records updated: ${updatedRecords}`);
    console.log(`Errors encountered: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log("\n❌ Errors:");
      errors.forEach(error => console.log(`  - ${error}`));
    }
    
    console.log("\n✅ Premier Performance daily update completed!");
    
  } catch (error) {
    console.error("\n❌ Premier daily update failed:", error.message);
    console.error("Stack trace:", error.stack);
    throw error;
  } finally {
    await prisma.$disconnect();
    
    const endTime = Date.now();
    const durationMinutes = ((endTime - startTime) / 60000).toFixed(2);
    console.log(`\nPremier update completed in ${durationMinutes} minutes.`);
    console.timeEnd("Premier Seed Duration");
  }
};

module.exports = seedDailyPremierData;

// Run if called directly
if (require.main === module) {
  seedDailyPremierData()
    .then(() => {
      console.log("Premier daily update completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Premier daily update failed:", error);
      process.exit(1);
    });
}