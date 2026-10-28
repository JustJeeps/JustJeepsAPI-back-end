require('dotenv').config();
const Turn14Service = require('../../../services/turn14');
const { USD_TO_CAD_RATE } = require('../../../utils/exchangeRate');

const prisma = require('../../../lib/prisma');

function createTurn14RateLimiter({ perSecond, perHour, perDay, minIntervalMs, stopOnDailyLimit }) {
  const state = {
    second: { start: Date.now(), count: 0 },
    hour: { start: Date.now(), count: 0 },
    day: { start: Date.now(), count: 0 },
    lastRequestAt: 0
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const rollWindowIfNeeded = (window, ms) => {
    const now = Date.now();
    if (now - window.start >= ms) {
      window.start = now;
      window.count = 0;
    }
  };

  const waitForWindow = async (window, ms, label) => {
    const now = Date.now();
    const waitMs = ms - (now - window.start);
    if (waitMs > 0) {
      const waitMinutes = Math.ceil(waitMs / (60 * 1000));
      console.log(`\n⏸️  Waiting ~${waitMinutes} minute(s) for ${label} window to reset...`);
      await sleep(waitMs);
      window.start = Date.now();
      window.count = 0;
    }
  };

  const ensureMinInterval = async () => {
    const now = Date.now();
    const elapsed = now - state.lastRequestAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
  };

  const consume = async (label) => {
    const now = Date.now();
    rollWindowIfNeeded(state.second, 1000);
    rollWindowIfNeeded(state.hour, 60 * 60 * 1000);
    rollWindowIfNeeded(state.day, 24 * 60 * 60 * 1000);

    if (state.day.count >= perDay) {
      const message = `\n🛑 Daily Turn14 limit reached (${state.day.count}/${perDay}).`;
      if (stopOnDailyLimit) {
        console.log(message);
        throw new Error('Turn14 daily limit reached. Stop and resume tomorrow.');
      }
      await waitForWindow(state.day, 24 * 60 * 60 * 1000, 'daily');
    }

    if (state.hour.count >= perHour) {
      await waitForWindow(state.hour, 60 * 60 * 1000, 'hourly');
    }

    if (state.second.count >= perSecond) {
      await waitForWindow(state.second, 1000, 'per-second');
    }

    await ensureMinInterval();

    state.second.count += 1;
    state.hour.count += 1;
    state.day.count += 1;
    state.lastRequestAt = Date.now();
  };

  const get = async (label, fn) => {
    await consume(label);
    return fn();
  };

  return { get };
}

async function seedTurn14VendorData() {
  const hrStartTime = process.hrtime();
  
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

    // Centralized rate limiter for Turn14 GET requests
    const rateLimiter = createTurn14RateLimiter({
      perSecond: 5,
      perHour: 5000,
      perDay: 30000,
      minIntervalMs: 250, // keep a small gap between requests
      stopOnDailyLimit: true
    });
    
    console.log('📋 Fetching Turn14 items (respecting rate limits)...');
    
    // With Turn14 rate limits (5 req/sec, 5000/hour, 30000/day), we need to be very conservative
    // Process matches per page instead of waiting for all pages
    const firstPage = await rateLimiter.get('items.getAllItems(1)', () =>
      turn14Service.items.getAllItems(1)
    );
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
    const startTimeMs = Date.now();
    
    // Start fresh from page 1 with clean data structure
    console.log('🔄 Starting fresh from page 1 with clean data structure...');
    
    // Process first page
    const page1Matches = await processPageAndSeed(firstPage.data, productLookupMap, 1, turn14Service, rateLimiter);
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
        const elapsedHours = (Date.now() - startTimeMs) / (1000 * 60 * 60);
        console.log(`📄 Fetching and processing page ${page}/${pagesToFetch}...`);
        const pageData = await rateLimiter.get(`items.getAllItems(${page})`, () =>
          turn14Service.items.getAllItems(page)
        );
        requestCount++; // Count the items API call
        
        if (pageData && pageData.data) {
          const pageResults = await processPageAndSeed(pageData.data, productLookupMap, page, turn14Service, rateLimiter);
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
    
    const endTime = process.hrtime(hrStartTime);
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
async function processPageAndSeed(turn14Items, productLookupMap, pageNumber, turn14Service, rateLimiter) {
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
        
        // Get pricing (reuse existing service instance)
        const pricingResult = await rateLimiter.get(`pricing.getItemPricing(${turn14Item.id})`, () =>
          turn14Service.pricing.getItemPricing(turn14Item.id)
        );
        requestCount++; // Count pricing API call

        // Get inventory (reuse existing service instance)
        const inventoryResult = await rateLimiter.get(`inventory.getItemInventory(${turn14Item.id})`, () =>
          turn14Service.inventory.getItemInventory(turn14Item.id)
        );
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
          vendor_cost: vendorCost * USD_TO_CAD_RATE, // USD to CAD conversion
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
        if (error && error.message && error.message.includes('Turn14 daily limit reached')) {
          console.error(`   🛑 Stopping: ${error.message}`);
          throw error;
        }
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