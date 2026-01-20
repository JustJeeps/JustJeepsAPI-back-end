const { PrismaClient } = require('@prisma/client');
const Turn14Service = require('../../../services/turn14');

const prisma = new PrismaClient();

/**
 * Daily Turn14 Production Seeding - Optimized for Regular Updates
 * Focuses on updating existing records and finding new matches efficiently
 */
async function dailyTurn14ProductionSeeding() {
  console.log('🔄 Daily Turn14 Production Seeding...');
  console.log('📅 Optimized for regular updates and new product discovery');
  console.log('⚡ Sustainable rate: 4,000 req/hour (80% of Turn14 limit)');

  try {
    // Initialize Turn14 service (reuses token to avoid limit violations)
    console.log('🔑 Initializing Turn14 service...');
    const turn14Service = new Turn14Service();
    
    console.log('📋 Fetching Turn14 items (respecting rate limits)...');
    
    // Get first page to understand catalog size
    const firstPage = await turn14Service.items.getAllItems(1);
    if (!firstPage || !firstPage.data) {
      console.log('❌ No Turn14 items found');
      return;
    }
    
    console.log(`📊 Turn14 API Info: ${firstPage.data.length} items on page 1`);
    if (firstPage.meta) {
      console.log(`📊 Total pages: ${firstPage.meta.total_pages}, Total items: ${firstPage.meta.total_count}`);
    }
    
    // Get all products with t14_code from our database ONCE
    console.log('📊 Fetching products with t14_code from database...');
    const products = await prisma.product.findMany({
      where: {
        t14_code: { not: null }
      },
      select: {
        sku: true,
        name: true,
        t14_code: true
      }
    });
    
    console.log(`✅ Found ${products.length} products with t14_code in database`);
    
    // Check current progress
    const currentCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`📊 Current Turn14 records in database: ${currentCount}\n`);

    // Create lookup map for our products
    const productLookupMap = new Map();
    products.forEach(product => {
      productLookupMap.set(product.t14_code.toLowerCase(), product);
    });

    let totalMatches = 0;
    let totalProcessed = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalErrors = 0;

    // Simple, sustainable rate limiting for daily operations
    let requestCount = 0;
    const maxRequestsPerHour = 4000; // 80% of Turn14's 5000 limit - sustainable daily rate
    const startTime = Date.now();
    const delayBetweenCalls = 900; // 900ms = ~4000 req/hour
    
    // Process ALL pages for comprehensive daily update
    const totalPages = firstPage.meta?.total_pages || 698;
    console.log(`🔄 Processing all ${totalPages} pages for comprehensive daily update...\n`);
    
    // Process first page
    const page1Matches = await processPageAndSeed(firstPage.data, productLookupMap, 1, turn14Service, delayBetweenCalls);
    totalMatches += page1Matches.matches;
    totalProcessed += page1Matches.processed;
    totalCreated += page1Matches.created;
    totalUpdated += page1Matches.updated;
    totalErrors += page1Matches.errors;
    requestCount += page1Matches.requestCount || 0;

    // Process remaining pages
    for (let page = 2; page <= totalPages; page++) {
      // Simple hourly rate limit check
      const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
      const currentRate = requestCount / elapsedHours;
      
      // If we're approaching the hourly limit, slow down
      if (currentRate > maxRequestsPerHour * 0.9) {
        console.log(`\n⚠️  Approaching rate limit (${Math.floor(currentRate)} req/hour), adding extra delay...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Extra delay
      } else {
        await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
      }
      
      console.log(`📄 Fetching and processing page ${page}/${totalPages}...`);
      const pageData = await turn14Service.items.getAllItems(page);
      requestCount++; // Count the items API call
      
      if (pageData && pageData.data) {
        const pageResults = await processPageAndSeed(pageData.data, productLookupMap, page, turn14Service, delayBetweenCalls);
        totalMatches += pageResults.matches;
        totalProcessed += pageResults.processed;
        totalCreated += pageResults.created;
        totalUpdated += pageResults.updated;
        totalErrors += pageResults.errors;
        requestCount += pageResults.requestCount || 0;
      }
      
      // Progress update every 20 pages for daily monitoring
      if (page % 20 === 0) {
        const currentElapsed = (Date.now() - startTime) / (1000 * 60 * 60);
        const avgRate = Math.floor(requestCount / currentElapsed);
        
        console.log(`\n📊 Daily Progress after ${page} pages:`);
        console.log(`   Total matches found: ${totalMatches}`);
        console.log(`   Total processed: ${totalProcessed}`);
        console.log(`   VendorProducts created: ${totalCreated}`);
        console.log(`   VendorProducts updated: ${totalUpdated}`);
        console.log(`   Errors: ${totalErrors}`);
        console.log(`   Current rate: ${avgRate} req/hour (target: ${maxRequestsPerHour})`);
        console.log(`   Runtime: ${Math.floor(currentElapsed * 60)} minutes`);
        
        // ETA calculation
        const remainingPages = totalPages - page;
        const pagesPerHour = page / currentElapsed;
        const etaHours = remainingPages / pagesPerHour;
        console.log(`   ETA: ${Math.floor(etaHours * 60)} minutes remaining\n`);
      }
    }

    // Final summary for daily operations
    const finalElapsed = (Date.now() - startTime) / (1000 * 60 * 60);
    const finalRate = Math.floor(requestCount / finalElapsed);
    
    console.log('\n🎉 Daily Turn14 Production Seeding Complete!');
    console.log(`📊 Daily Summary:`);
    console.log(`   Total matches found: ${totalMatches}`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   VendorProducts created: ${totalCreated}`);
    console.log(`   VendorProducts updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Total API requests: ${requestCount}`);
    console.log(`   Average rate: ${finalRate} req/hour`);
    console.log(`   Total runtime: ${Math.floor(finalElapsed * 60)} minutes`);
    
    // Final database count
    const finalCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`   Turn14 records in database: ${finalCount}`);
    
    // Daily insights
    if (totalUpdated > 0) {
      console.log(`\n💡 Daily Insights:`);
      console.log(`   - Updated ${totalUpdated} existing product prices/inventory`);
      if (totalCreated > 0) {
        console.log(`   - Found ${totalCreated} new products to add`);
      }
      console.log(`   - Maintained up-to-date Turn14 catalog data`);
    }

  } catch (error) {
    console.error('❌ Error in daily Turn14 production seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Process a single page with sustainable daily rate limiting
 */
async function processPageAndSeed(turn14Items, productLookupMap, pageNumber, turn14Service, delay) {
  let matches = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;
  let requestCount = 0;
  
  // Find matches on this page
  const pageMatches = [];
  turn14Items.forEach(turn14Item => {
    if (turn14Item.attributes && turn14Item.attributes.part_number) {
      const product = productLookupMap.get(turn14Item.attributes.part_number.toLowerCase());
      if (product) {
        pageMatches.push({ product, turn14Item });
        matches++;
      }
    }
  });
  
  if (pageMatches.length > 0) {
    console.log(`   ✅ Found ${pageMatches.length} matches on page ${pageNumber}`);
    
    // Process each match with consistent rate limiting
    for (const match of pageMatches) {
      try {
        processed++;
        const { product, turn14Item } = match;
        
        console.log(`   🔄 Processing: ${product.sku} → Turn14 ID: ${turn14Item.id}`);
        
        // Sustainable rate limiting
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Get pricing (reuse existing service instance)
        const pricingResult = await turn14Service.pricing.getItemPricing(turn14Item.id);
        requestCount++; // Count pricing API call
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Get inventory (reuse existing service instance)
        const inventoryResult = await turn14Service.inventory.getItemInventory(turn14Item.id);
        requestCount++; // Count inventory API call

        let vendorCost = 0;
        let vendorInventory = 0;

        // Process pricing
        if (pricingResult && pricingResult.data && pricingResult.data.attributes) {
          vendorCost = pricingResult.data.attributes.purchase_cost || 0;
        }

        // Process inventory
        if (inventoryResult && inventoryResult.data && inventoryResult.data.length > 0) {
          const inventory = inventoryResult.data[0];
          if (inventory.attributes && inventory.attributes.inventory_quantity !== undefined) {
            vendorInventory = inventory.attributes.inventory_quantity;
          }
        }

        // Check if vendor product already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            product_sku: product.sku,
            vendor_id: 15
          }
        });

        if (existingVendorProduct) {
          // Update existing vendor product (daily price/inventory refresh)
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: {
              vendor_cost: vendorCost*1.5, // FIXED: Turn14 already provides correct currency
              vendor_inventory: vendorInventory,
              vendor_sku: turn14Item.attributes.part_number
            }
          });

          updated++;
          console.log(`   ✅ Updated: ${product.sku} | Cost: $${vendorCost} | Inventory: ${vendorInventory}`);
        } else {
          // Create new vendor product (new discoveries)
          await prisma.vendorProduct.create({
            data: {
              product_sku: product.sku,
              vendor_id: 15,
              vendor_cost: vendorCost*1.5, // FIXED: Turn14 already provides correct currency
              vendor_inventory: vendorInventory,
              vendor_sku: turn14Item.attributes.part_number
            }
          });

          created++;
          console.log(`   ✅ Created: ${product.sku} | Cost: $${vendorCost} | Inventory: ${vendorInventory}`);
        }

      } catch (error) {
        errors++;
        console.error(`   ❌ Error processing ${match.product.sku}:`, error.message);
      }
    }
  } else {
    console.log(`   ➖ No matches found on page ${pageNumber}`);
  }
  
  return { matches, processed, created, updated, errors, requestCount };
}

// Run the daily seeding
dailyTurn14ProductionSeeding().catch(console.error);