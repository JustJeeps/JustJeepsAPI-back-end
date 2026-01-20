const { PrismaClient } = require('@prisma/client');
const Turn14Service = require('../../../services/turn14');

const prisma = new PrismaClient();

/**
 * Resume Turn14 Production Seeding from Page 273
 * ULTRA-CONSERVATIVE rate limiting to prevent further violations
 */
async function resumeTurn14ProductionSeeding() {
  console.log('🚀 Resuming Turn14 Production Seeding from Page 273...');
  console.log('🛡️  Using ULTRA-CONSERVATIVE rate limiting (3000 req/hour, 1000ms delays)');

  try {
    // Initialize Turn14 service (reuses token to avoid token limit violations)
    console.log('🔑 Initializing Turn14 service...');
    const turn14Service = new Turn14Service();
    
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

    // ULTRA-CONSERVATIVE rate limit tracking
    let requestCount = 0;
    const maxRequestsPerHour = 3000; // Very conservative limit (was 4500, hit 7487)
    const startTime = Date.now();
    
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
    
    // Start from page 273 (where we left off)
    const startPage = 273;
    console.log(`🔄 Resuming from page ${startPage}/${totalPages}...\n`);
    
    for (let page = startPage; page <= totalPages; page++) {
      // Check hourly rate limit BEFORE each page
      const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
      if (requestCount >= maxRequestsPerHour && elapsedHours < 1) {
        const waitTime = (1 - elapsedHours) * 60; // minutes to wait
        console.log(`\n⏰ RATE LIMIT PROTECTION: ${requestCount}/${maxRequestsPerHour} requests used`);
        console.log(`⏸️  Pausing for ${Math.ceil(waitTime)} minutes to reset hourly limit...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 60 * 1000));
        requestCount = 0; // Reset counter
      }
      
      // Ultra-conservative delay between page requests
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log(`📄 Fetching and processing page ${page}/${totalPages}...`);
      const pageData = await turn14Service.items.getAllItems(page);
      requestCount++; // Count the items API call
      
      if (pageData && pageData.data) {
        const pageResults = await processPageAndSeed(pageData.data, productLookupMap, page, turn14Service);
        totalMatches += pageResults.matches;
        totalProcessed += pageResults.processed;
        totalCreated += pageResults.created;
        totalUpdated += pageResults.updated;
        totalErrors += pageResults.errors;
        requestCount += pageResults.requestCount || 0; // Add pricing/inventory API calls
      }
      
      // Progress update every 5 pages (more frequent monitoring)
      if (page % 5 === 0) {
        console.log(`\n📊 Progress after ${page} pages:`);
        console.log(`   Total matches found: ${totalMatches}`);
        console.log(`   Total processed: ${totalProcessed}`);
        console.log(`   VendorProducts created: ${totalCreated}`);
        console.log(`   VendorProducts updated: ${totalUpdated}`);
        console.log(`   Errors: ${totalErrors}`);
        console.log(`   API requests this hour: ${requestCount}/${maxRequestsPerHour}`);
        
        // Extra warning if approaching limit
        if (requestCount > maxRequestsPerHour * 0.8) {
          console.log(`   ⚠️  WARNING: Approaching rate limit! (${requestCount}/${maxRequestsPerHour})`);
        }
        console.log('');
      }
    }

    // Final summary
    console.log('\n🎉 Turn14 Production Seeding Resumed Complete!');
    console.log(`📊 Final Summary:`);
    console.log(`   Total matches found: ${totalMatches}`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   VendorProducts created: ${totalCreated}`);
    console.log(`   VendorProducts updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Total API requests used: ${requestCount}`);
    
    // Check final database count
    const finalCount = await prisma.vendorProduct.count({
      where: { vendor_id: 15 }
    });
    console.log(`   Turn14 records in database: ${finalCount}`);

  } catch (error) {
    console.error('❌ Error in Turn14 production seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Process a single page of Turn14 items and immediately seed matches
 * ULTRA-CONSERVATIVE version with 1000ms delays
 */
async function processPageAndSeed(turn14Items, productLookupMap, pageNumber, turn14Service) {
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
    
    // Process each match immediately with ULTRA-CONSERVATIVE delays
    for (const match of pageMatches) {
      try {
        processed++;
        const { product, turn14Item } = match;
        
        console.log(`   🔄 Processing: ${product.sku} → Turn14 ID: ${turn14Item.id}`);
        
        // ULTRA-CONSERVATIVE rate limiting between pricing/inventory calls
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Get pricing (reuse existing service instance)
        const pricingResult = await turn14Service.pricing.getItemPricing(turn14Item.id);
        requestCount++; // Count pricing API call
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
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
          if (inventory.attributes && inventory.attributes.inventory) {
            // Calculate total available inventory across all locations
            const inventoryByLocation = inventory.attributes.inventory;
            vendorInventory = Object.values(inventoryByLocation).reduce((sum, qty) => sum + (qty || 0), 0);
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
          // Update existing vendor product (clean data only)
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
          // Create new vendor product (clean data only)
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

// Run the seeding
resumeTurn14ProductionSeeding().catch(console.error);