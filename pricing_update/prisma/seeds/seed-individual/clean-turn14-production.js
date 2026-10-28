const Turn14Service = require('../../../services/turn14');

const prisma = require('../../../lib/prisma');

/**
 * Clean & Simple Turn14 Production Seeding
 * Sustainable 4,000 req/hour rate (80% of Turn14's 5,000 limit)
 */
async function cleanTurn14ProductionSeeding() {
  console.log('🚀 Clean Turn14 Production Seeding - Continuing Progress...');
  console.log('⚡ Sustainable rate: ~4,000 req/hour (80% of Turn14 limit)');

  try {
    // Initialize Turn14 service
    console.log('🔑 Initializing Turn14 service...');
    const turn14Service = new Turn14Service();
    
    // Get all products with t14_code from database
    console.log('📊 Loading products with t14_code...');
    const products = await prisma.product.findMany({
      where: { t14_code: { not: null } },
      select: { sku: true, name: true, t14_code: true }
    });
    
    console.log(`✅ Found ${products.length} products with t14_code`);
    
    // Check current progress
    const currentCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`📊 Current Turn14 records: ${currentCount}`);

    // Create lookup map
    const productLookupMap = new Map();
    products.forEach(product => {
      productLookupMap.set(product.t14_code.toLowerCase(), product);
    });

    // Progress tracking
    let totalMatches = 0;
    let totalProcessed = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    let totalRequests = 0;

    // Simple rate limiting: 900ms between API calls = ~4,000 req/hour
    const delayBetweenCalls = 900; // milliseconds
    const startTime = Date.now();
    
    // Get total pages
    console.log('📋 Getting Turn14 page count...');
    const firstPage = await turn14Service.items.getAllItems(1);
    totalRequests++;
    
    const totalPages = firstPage.meta?.total_pages || 698;
    console.log(`📊 Total Turn14 pages: ${totalPages}`);
    
    // Smart start point: estimate based on current records
    // Average ~10-15 matches per page, so start around page 500
    const estimatedStartPage = Math.max(400, Math.floor(currentCount / 12));
    console.log(`🔄 Starting from estimated page ${estimatedStartPage}/${totalPages}...\n`);
    
    for (let page = estimatedStartPage; page <= totalPages; page++) {
      // Simple delay for rate limiting
      await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
      
      console.log(`📄 Processing page ${page}/${totalPages}...`);
      
      try {
        const pageData = await turn14Service.items.getAllItems(page);
        totalRequests++;
        
        if (pageData && pageData.data) {
          const pageResults = await processPageAndSeed(
            pageData.data, 
            productLookupMap, 
            page, 
            turn14Service,
            delayBetweenCalls
          );
          
          totalMatches += pageResults.matches;
          totalProcessed += pageResults.processed;
          totalCreated += pageResults.created;
          totalUpdated += pageResults.updated;
          totalErrors += pageResults.errors;
          totalRequests += pageResults.requestCount;
        }
        
        // Progress update every 10 pages
        if (page % 10 === 0) {
          const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
          const requestsPerHour = Math.floor(totalRequests / elapsedHours);
          
          console.log(`\n📊 Progress after ${page} pages:`);
          console.log(`   Matches found: ${totalMatches}`);
          console.log(`   Products processed: ${totalProcessed}`);
          console.log(`   Created: ${totalCreated} | Updated: ${totalUpdated}`);
          console.log(`   Errors: ${totalErrors}`);
          console.log(`   Rate: ${requestsPerHour} req/hour (target: ~4,000)`);
          console.log(`   Elapsed: ${Math.floor(elapsedHours * 60)} minutes\n`);
        }
        
      } catch (error) {
        console.error(`❌ Error on page ${page}:`, error.message);
        totalErrors++;
      }
    }

    // Final summary
    const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
    const finalRequestsPerHour = Math.floor(totalRequests / elapsedHours);
    
    console.log('\n🎉 Clean Turn14 Production Seeding Complete!');
    console.log(`📊 Final Summary:`);
    console.log(`   Total matches found: ${totalMatches}`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   VendorProducts created: ${totalCreated}`);
    console.log(`   VendorProducts updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Total requests: ${totalRequests}`);
    console.log(`   Average rate: ${finalRequestsPerHour} req/hour`);
    console.log(`   Runtime: ${Math.floor(elapsedHours * 60)} minutes`);
    
    // Final database count
    const finalCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`   Turn14 records in database: ${finalCount}`);

  } catch (error) {
    console.error('❌ Error in Turn14 seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Simple page processing with consistent rate limiting
 */
async function processPageAndSeed(turn14Items, productLookupMap, pageNumber, turn14Service, delay) {
  let matches = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;
  let requestCount = 0;
  
  // Find matches
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
    
    // Process each match with consistent delays
    for (const match of pageMatches) {
      try {
        processed++;
        const { product, turn14Item } = match;
        
        console.log(`   🔄 Processing: ${product.sku} → Turn14 ID: ${turn14Item.id}`);
        
        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Get pricing
        const pricingResult = await turn14Service.pricing.getItemPricing(turn14Item.id);
        requestCount++;
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Get inventory
        const inventoryResult = await turn14Service.inventory.getItemInventory(turn14Item.id);
        requestCount++;
        
        // Process data
        let vendorCost = 0;
        let vendorInventory = 0;
        
        if (pricingResult && pricingResult.data && pricingResult.data.attributes) {
          vendorCost = pricingResult.data.attributes.purchase_cost || 0;
        }
        
        if (inventoryResult && inventoryResult.data && inventoryResult.data.length > 0) {
          const inventory = inventoryResult.data[0];
          if (inventory.attributes && inventory.attributes.inventory_quantity !== undefined) {
            vendorInventory = inventory.attributes.inventory_quantity;
          }
        }
        
        // Database operations
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            product_sku: product.sku,
            vendor_id: 15
          }
        });
        
        if (existingVendorProduct) {
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

// Run the clean seeding
cleanTurn14ProductionSeeding().catch(console.error);