require('dotenv').config();
const Turn14Service = require('../../../services/turn14');

const prisma = require('../../../lib/prisma');

async function seedTurn14VendorData() {
  const startTime = process.hrtime();
  
  try {
    console.log('🚀 Turn14 Vendor Data Seeding - Production Version\n');
    
    // Clean up existing Turn14 data first
    console.log('🧹 Cleaning up existing Turn14 data (vendor_id=15)...');
    const deletedCount = await prisma.vendorProduct.deleteMany({
      where: {
        vendor_id: 15
      }
    });
    console.log(`✅ Deleted ${deletedCount.count} existing Turn14 vendor records\n`);
    
    // Initialize Turn14 service
    const turn14Service = new Turn14Service();
    
    console.log('📋 Fetching Turn14 items (respecting rate limits)...');
    
    // With Turn14 rate limits (5 req/sec, 5000/hour, 30000/day), we need to be very conservative
    // Process matches per page instead of waiting for all pages
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
    
    console.log(`✅ Found ${products.length} products with t14_code in database\n`);
    
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
    
    // Rate limit tracking (Turn14: 5000 req/hour, 5 req/sec, 30000/day)
    let requestCount = 0;
    const maxRequestsPerHour = 3000; // Very conservative limit (was 4500, but we hit 7487)
    const startTime = Date.now();
    
    // Start fresh from page 1 with clean data structure
    console.log('🔄 Starting fresh from page 1 with clean data structure...');
    
    // Process first page
    const page1Matches = await processPageAndSeed(firstPage.data, productLookupMap, 1, turn14Service);
    totalMatches += page1Matches.matches;
    totalProcessed += page1Matches.processed;
    totalCreated += page1Matches.created;
    totalUpdated += page1Matches.updated;
    totalErrors += page1Matches.errors;
    requestCount += page1Matches.requestCount || 0;
    
    // Process additional pages starting from page 2
    const totalPages = firstPage.meta?.total_pages || 1;
    const pagesToFetch = totalPages; // Process ALL Turn14 pages
    
    if (totalPages > 1 && pagesToFetch > 1) {
      console.log(`📋 Processing ${pagesToFetch - 1} more pages (2-${totalPages})...\n`);
      
      for (let page = 2; page <= pagesToFetch; page++) {
        // Check hourly rate limit
        const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
        if (requestCount >= maxRequestsPerHour && elapsedHours < 1) {
          const waitTime = (1 - elapsedHours) * 60; // minutes to wait
          console.log(`\n⏰ Approaching hourly rate limit (${requestCount}/${maxRequestsPerHour} requests)`);
          console.log(`⏸️  Pausing for ${Math.ceil(waitTime)} minutes to reset hourly limit...`);
          await new Promise(resolve => setTimeout(resolve, waitTime * 60 * 1000));
          requestCount = 0; // Reset counter
        }
        
        // Rate limiting: 1000ms between API calls (much more conservative)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`📄 Fetching and processing page ${page}/${pagesToFetch}...`);
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
        
        // Progress update every 10 pages
        if (page % 10 === 0) {
          console.log(`\n📊 Progress after ${page} pages:`);
          console.log(`   Total matches found: ${totalMatches}`);
          console.log(`   Total processed: ${totalProcessed}`);
          console.log(`   VendorProducts created: ${totalCreated}`);
          console.log(`   VendorProducts updated: ${totalUpdated}`);
          console.log(`   Errors: ${totalErrors}`);
          console.log(`   API requests this hour: ${requestCount}/${maxRequestsPerHour}\n`);
        }
      }
    }
    
    const endTime = process.hrtime(startTime);
    const duration = `${Math.floor(endTime[0] / 60)}:${(endTime[0] % 60).toString().padStart(2, '0')}.${Math.floor(endTime[1] / 1000000).toString().padStart(3, '0')}`;
    
    console.log('\n🎉 Turn14 vendor data seeding completed!');
    console.log('� Final Summary:');
    console.log(`   Pages processed: ${Math.min(pagesToFetch, totalPages)}`);
    console.log(`   Total matches found: ${totalMatches}`);
    console.log(`   Products processed: ${totalProcessed}`);
    console.log(`   VendorProducts created: ${totalCreated}`);
    console.log(`   VendorProducts updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`Processing time: ${duration} (m:ss.mmm)`);
    console.log('💥 Done!');
    
  } catch (error) {
    console.error('❌ Fatal error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Function to process a page of Turn14 items and seed matches immediately
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
    
    // Process each match immediately
    for (const match of pageMatches) {
      try {
        processed++;
        const { product, turn14Item } = match;
        
        console.log(`   🔄 Processing: ${product.sku} → Turn14 ID: ${turn14Item.id}`);
        
        // Much more conservative rate limiting between pricing/inventory calls
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
        let inventoryData = null;
        
        // Process pricing
        if (pricingResult && pricingResult.data && pricingResult.data.attributes) {
          vendorCost = pricingResult.data.attributes.purchase_cost || 0;
        }
        
        // Process inventory
        if (inventoryResult && inventoryResult.data && inventoryResult.data.length > 0) {
          const inventory = inventoryResult.data[0];
          
          if (inventory.attributes && inventory.attributes.inventory) {
            const inventoryByLocation = inventory.attributes.inventory;
            vendorInventory = Object.values(inventoryByLocation).reduce((sum, qty) => sum + (qty || 0), 0);
            
            inventoryData = {
              turn14_id: turn14Item.id,
              part_number: turn14Item.attributes.part_number,
              brand: turn14Item.attributes.brand,
              inventory_by_location: inventoryByLocation,
              total_inventory: vendorInventory,
              manufacturer_stock: inventory.attributes.manufacturer?.stock || 0,
              updated_at: new Date().toISOString()
            };
          }
        }
        
        // Seed to database immediately
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 15, // Turn14 Distribution
          vendor_cost: vendorCost*1.5, // USD to CAD conversion
          vendor_inventory: vendorInventory
          // Removed vendor_inventory_string to keep database cleaner
        };
        
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
              vendor_cost: vendorProductData.vendor_cost,
              vendor_inventory: vendorProductData.vendor_inventory
              // Removed vendor_inventory_string update
            }
          });
          updated++;
          console.log(`   ✅ Updated: ${product.sku} | Cost: $${vendorCost} | Inventory: ${vendorInventory}`);
        } else {
          await prisma.vendorProduct.create({
            data: {
              ...vendorProductData,
              vendor_sku: turn14Item.attributes.part_number || ''
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
    console.log(`   📄 No matches found on page ${pageNumber}`);
  }
  
  return { matches, processed, created, updated, errors, requestCount };
}

// Run the seeding
seedTurn14VendorData();