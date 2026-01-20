const { PrismaClient } = require("@prisma/client");
const Turn14Service = require("../../../services/turn14");

const prisma = new PrismaClient();

/**
 * OPTIMIZED Turn14 Seeding - Search products individually instead of fetching all items
 * This is MUCH faster than downloading 698K items first
 */
const seedTurn14Optimized = async (brandFilter = null) => {
  try {
    console.log("🚀 Starting OPTIMIZED Turn14 vendor seeding (vendor_id = 15)");
    if (brandFilter) {
      console.log(`🎯 Filtering for brand: ${brandFilter}`);
    }
    console.time("Turn14 Seeding");

    const turn14Service = new Turn14Service();
    
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let matchedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get products with t14_code from our database
    console.log("📋 Finding products with t14_code...");
    
    const whereClause = {
      t14_code: { 
        not: null,
        not: ""
      }
    };
    
    // Add brand filter if specified
    if (brandFilter) {
      whereClause.jj_prefix = brandFilter;
    }
    
    const products = await prisma.product.findMany({
      where: whereClause,
      select: {
        sku: true,
        searchable_sku: true,
        name: true,
        t14_code: true,
        jj_prefix: true,
        brand_name: true,
      }
    });

    console.log(`📊 Found ${products.length} products with t14_code`);
    
    if (products.length === 0) {
      console.log("⚠️ No products found. Exiting.");
      return;
    }

    // Process in small batches with delays to avoid rate limiting
    const batchSize = 10;
    
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(products.length / batchSize);
      
      console.log(`\n🔄 Processing batch ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + batchSize, products.length)} of ${products.length})`);
      
      for (const product of batch) {
        try {
          // Search for this specific product by part number using the items service
          console.log(`  🔍 Searching Turn14 for: ${product.t14_code}`);
          
          // Use the searchByPartNumber method which filters items
          const matchingItems = await turn14Service.items.searchByPartNumber(product.t14_code);
          
          if (!matchingItems || matchingItems.length === 0) {
            skippedCount++;
            console.log(`  ⏭️  No match found for ${product.sku}`);
            continue;
          }

          // Use the first matching item
          const turn14Item = matchingItems[0];
          matchedCount++;
          console.log(`  ✅ Match found: ${product.sku} → Turn14 ID: ${turn14Item.id}`);

          // Get pricing and inventory for this specific item
          const [pricingResult, inventoryResult] = await Promise.all([
            turn14Service.pricing.getItemPricing(turn14Item.id),
            turn14Service.inventory.getItemInventory(turn14Item.id)
          ]);

          let vendorCost = null;
          let vendorInventory = null;
          let inventoryData = null;

          // Extract pricing from attributes
          if (pricingResult && pricingResult.data && pricingResult.data.attributes) {
            const pricing = pricingResult.data.attributes;
            // Turn14 uses purchase_cost, not cost
            vendorCost = pricing.purchase_cost || pricing.jobber_price || 0;
            console.log(`    💰 Cost: $${vendorCost}`);
          }

          // Extract inventory from attributes
          if (inventoryResult && inventoryResult.data && inventoryResult.data.length > 0) {
            const inventory = inventoryResult.data[0];
            
            if (inventory.attributes && inventory.attributes.inventory) {
              // Inventory is an object with location IDs as keys
              const inventoryObj = inventory.attributes.inventory;
              let totalInventory = 0;
              
              // Sum up inventory across all locations
              Object.values(inventoryObj).forEach(locationData => {
                if (locationData && typeof locationData.quantity === 'number') {
                  totalInventory += locationData.quantity;
                }
              });
              
              vendorInventory = totalInventory;
              inventoryData = {
                turn14_id: turn14Item.id,
                part_number: turn14Item.attributes.part_number,
                brand: turn14Item.attributes.brand,
                inventory_by_location: inventoryObj,
                total_inventory: totalInventory,
                updated_at: new Date().toISOString()
              };
              console.log(`    📦 Inventory: ${totalInventory} units`);
            }
          }

          // Create or update VendorProduct
          const existingVendorProduct = await prisma.vendorProduct.findFirst({
            where: {
              vendor_sku: turn14Item.attributes.part_number,
              vendor_id: 15,
              product_sku: product.sku
            },
          });

          const vendorProductData = {
            vendor_cost: vendorCost,
            vendor_inventory: vendorInventory,
            vendor_inventory_string: inventoryData ? JSON.stringify(inventoryData) : null
          };

          if (existingVendorProduct) {
            await prisma.vendorProduct.update({
              where: { id: existingVendorProduct.id },
              data: vendorProductData,
            });
            vendorProductUpdatedCount++;
            console.log(`    🔄 Updated`);
          } else {
            await prisma.vendorProduct.create({
              data: {
                vendor_sku: turn14Item.attributes.part_number,
                vendor_id: 15,
                product_sku: product.sku,
                ...vendorProductData,
              },
            });
            vendorProductCreatedCount++;
            console.log(`    ✨ Created`);
          }

        } catch (error) {
          console.log(`  ❌ Error: ${error.message}`);
          errorCount++;
        }
      }
      
      // Add delay between batches to avoid rate limiting
      if (i + batchSize < products.length) {
        console.log("  ⏸️  Waiting 2 seconds...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary
    console.log("\n🎉 Turn14 seeding completed!");
    console.log(`📊 Summary:`);
    console.log(`   Products processed: ${products.length}`);
    console.log(`   Matched with Turn14: ${matchedCount}`);
    console.log(`   Skipped (no match): ${skippedCount}`);
    console.log(`   Vendor products created: ${vendorProductCreatedCount}`);
    console.log(`   Vendor products updated: ${vendorProductUpdatedCount}`);
    console.log(`   Errors: ${errorCount}`);
    
    console.timeEnd("Turn14 Seeding");

  } catch (error) {
    console.error("🚨 Error:", error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
};

// Get brand filter from command line args
const brandFilter = process.argv[2] || null;

// Run
seedTurn14Optimized(brandFilter)
  .then(() => {
    console.log("💥 Seeding completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Seeding failed:", error);
    process.exit(1);
  });

module.exports = seedTurn14Optimized;
