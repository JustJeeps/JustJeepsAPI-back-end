const { PrismaClient } = require('@prisma/client');
const Turn14Service = require('../../../services/turn14');

const prisma = new PrismaClient();

/**
 * FIXED Turn14 Production Seeding with PROPER hourly rate limiting
 * Fixes the critical bug where rate limiting stopped working after 1 hour
 */
async function fixedTurn14ProductionSeeding() {
  console.log('🚀 Starting FIXED Turn14 Production Seeding...');
  console.log('🛡️  Using PROPER hourly rate limiting (2500 req/hour, 1500ms delays)');
  console.log('🔧 Fixed the hourly reset bug that caused 8,279 requests!');

  try {
    // Initialize Turn14 service
    console.log('🔑 Initializing Turn14 service...');
    const turn14Service = new Turn14Service();
    
    // Get all products with t14_code from our database
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
    console.log(`📊 Current Turn14 records in database: ${currentCount}`);

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

    // FIXED rate limiting with proper hourly tracking
    let requestCount = 0;
    let hourlyStartTime = Date.now();
    const maxRequestsPerHour = 2500; // Even more conservative after the violation
    
    // Get first page to determine total pages
    console.log('📋 Getting total page count from Turn14...');
    const firstPage = await turn14Service.items.getAllItems(1);
    requestCount++; // Count this API call
    
    if (!firstPage || !firstPage.meta) {
      console.log('❌ Could not get page count from Turn14');
      return;
    }
    
    const totalPages = firstPage.meta.total_pages || 1;
    console.log(`📊 Total Turn14 pages: ${totalPages}`);
    
    // Determine start page based on current progress
    const estimatedCurrentPage = Math.floor(currentCount / 10) || 273; // Estimate based on records
    const startPage = Math.max(estimatedCurrentPage, 273);
    console.log(`🔄 Starting from estimated page ${startPage}/${totalPages}...\n`);
    
    for (let page = startPage; page <= totalPages; page++) {
      // FIXED: Proper hourly rate limit check
      const currentTime = Date.now();
      const elapsedHours = (currentTime - hourlyStartTime) / (1000 * 60 * 60);
      
      // If we've used too many requests in the current hour, wait for reset
      if (requestCount >= maxRequestsPerHour) {
        if (elapsedHours < 1) {
          const waitTime = (1 - elapsedHours) * 60; // minutes to wait
          console.log(`\n⏰ HOURLY RATE LIMIT REACHED: ${requestCount}/${maxRequestsPerHour} requests`);
          console.log(`⏸️  Pausing for ${Math.ceil(waitTime)} minutes to reset...`);
          console.log(`⏰ Current time: ${new Date().toLocaleString()}`);
          await new Promise(resolve => setTimeout(resolve, waitTime * 60 * 1000));
        }
        
        // Reset hourly counter
        requestCount = 0;
        hourlyStartTime = Date.now();
        console.log(`🔄 Hourly counter reset at ${new Date().toLocaleString()}`);
      }
      
      // Extra conservative delay between page requests
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      console.log(`📄 Fetching and processing page ${page}/${totalPages}...`);
      console.log(`📊 Hourly status: ${requestCount}/${maxRequestsPerHour} requests (${Math.floor(elapsedHours * 60)}min elapsed)`);
      
      const pageData = await turn14Service.items.getAllItems(page);
      requestCount++; // Count the items API call
      
      if (pageData && pageData.data) {
        const pageResults = await processPageAndSeed(pageData.data, productLookupMap, page, turn14Service, requestCount, maxRequestsPerHour);
        totalMatches += pageResults.matches;
        totalProcessed += pageResults.processed;
        totalCreated += pageResults.created;
        totalUpdated += pageResults.updated;
        totalErrors += pageResults.errors;
        requestCount += pageResults.requestCount || 0; // Add pricing/inventory API calls
      }
      
      // Progress update every 3 pages (more frequent monitoring)
      if (page % 3 === 0) {
        const currentElapsed = (Date.now() - hourlyStartTime) / (1000 * 60 * 60);
        console.log(`\n📊 Progress after ${page} pages:`);
        console.log(`   Total matches found: ${totalMatches}`);
        console.log(`   Total processed: ${totalProcessed}`);
        console.log(`   VendorProducts created: ${totalCreated}`);
        console.log(`   VendorProducts updated: ${totalUpdated}`);
        console.log(`   Errors: ${totalErrors}`);
        console.log(`   Hourly requests: ${requestCount}/${maxRequestsPerHour} (${Math.floor(currentElapsed * 60)}min elapsed)`);
        
        // Critical warning if approaching limit
        if (requestCount > maxRequestsPerHour * 0.9) {
          console.log(`   🚨 CRITICAL: Very close to hourly limit!`);
        } else if (requestCount > maxRequestsPerHour * 0.8) {
          console.log(`   ⚠️  WARNING: Approaching hourly limit!`);
        }
        console.log('');
      }
    }

    // Final summary
    console.log('\n🎉 Fixed Turn14 Production Seeding Complete!');
    console.log(`📊 Final Summary:`);
    console.log(`   Total matches found: ${totalMatches}`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   VendorProducts created: ${totalCreated}`);
    console.log(`   VendorProducts updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Total API requests used: ${requestCount + (Math.floor(totalProcessed * 2))}`); // Estimate total
    
    // Check final database count
    const finalCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`   Turn14 records in database: ${finalCount}`);

  } catch (error) {
    console.error('❌ Error in fixed Turn14 production seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * FIXED processPageAndSeed with proper rate limit tracking
 */
async function processPageAndSeed(turn14Items, productLookupMap, pageNumber, turn14Service, currentHourlyCount, maxHourlyLimit) {
  let matches = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;
  let requestCount = 0; // Track API calls made in this function
  
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
    
    // Process each match with proper rate limiting
    for (const match of pageMatches) {
      try {
        processed++;
        const { product, turn14Item } = match;
        
        // Check if we're approaching hourly limit before making API calls
        if (currentHourlyCount + requestCount >= maxHourlyLimit - 10) {
          console.log(`   ⚠️  Approaching hourly limit, stopping page processing`);
          break;
        }
        
        console.log(`   🔄 Processing: ${product.sku} → Turn14 ID: ${turn14Item.id}`);
        
        // Extra conservative delays
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Get pricing
        const pricingResult = await turn14Service.pricing.getItemPricing(turn14Item.id);
        requestCount++; // Count pricing API call
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Get inventory
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
          // Update existing vendor product
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: {
              vendor_cost: vendorCost,
              vendor_inventory: vendorInventory,
              vendor_sku: turn14Item.attributes.part_number
            }
          });
          
          updated++;
          console.log(`   ✅ Updated: ${product.sku} | Cost: $${vendorCost} | Inventory: ${vendorInventory}`);
        } else {
          // Create new vendor product
          await prisma.vendorProduct.create({
            data: {
              product_sku: product.sku,
              vendor_id: 15,
              vendor_cost: vendorCost,
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

// Run the fixed seeding
fixedTurn14ProductionSeeding().catch(console.error);