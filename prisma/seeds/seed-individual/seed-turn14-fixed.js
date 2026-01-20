const { PrismaClient } = require("@prisma/client");
const Turn14Service = require("../../../services/turn14");
const vendorsPrefix = require("../hard-code_data/vendors_prefix");

const prisma = new PrismaClient();

// Seed Turn14 vendor products (vendor_id = 15)
const seedTurn14VendorProducts = async () => {
  try {
    console.log("🚀 Starting Turn14 vendor products seeding (vendor_id = 15)");
    console.time("Turn14 Seeding");

    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let matchedCount = 0;

    // Initialize Turn14 service
    const turn14Service = new Turn14Service();

    // ✅ Step 1: Get ALL items from Turn14 to create id + part_number mapping
    console.log("📋 Fetching ALL items from Turn14 API...");
    
    // Since Turn14 uses pagination, we need to fetch all pages
    const allItems = [];
    let page = 1;
    let hasMorePages = true;
    
    while (hasMorePages) {
      console.log(`  📄 Fetching page ${page}...`);
      const itemsResult = await turn14Service.items.getAllItems(page);
      
      if (!itemsResult || !itemsResult.data || itemsResult.data.length === 0) {
        hasMorePages = false;
        break;
      }
      
      allItems.push(...itemsResult.data);
      
      // Check if there are more pages (you might need to adjust this based on Turn14's response structure)
      if (itemsResult.data.length < 100) { // Assuming 100 items per page as default
        hasMorePages = false;
      } else {
        page++;
      }
      
      // Add a small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`📊 Found ${allItems.length} total items in Turn14`);
    
    // Create a mapping of part_number to Turn14 item data (including id)
    const turn14ItemsMap = new Map();
    for (const item of allItems) {
      if (item.attributes && item.attributes.part_number) {
        turn14ItemsMap.set(item.attributes.part_number.toLowerCase(), {
          id: item.id,
          part_number: item.attributes.part_number,
          brand: item.attributes.brand,
          description: item.attributes.part_description,
          product_name: item.attributes.product_name
        });
      }
    }

    console.log(`🗂️ Created mapping for ${turn14ItemsMap.size} Turn14 items`);

    // ✅ Step 2: Get products with t14_code from our database
    console.log("📋 Finding products with t14_code...");
    
    const productsWithT14Code = await prisma.product.findMany({
      where: {
        t14_code: { 
          not: null,
          not: ""
        }
      },
      select: {
        sku: true,
        searchable_sku: true,
        name: true,
        t14_code: true,
        jj_prefix: true,
        brand_name: true,
      }
    });

    console.log(`📊 Found ${productsWithT14Code.length} products with t14_code`);
    
    if (productsWithT14Code.length === 0) {
      console.log("⚠️ No products found with t14_code. Make sure products have been seeded with t14_code fields.");
      return;
    }

    // ✅ Step 3: Process each product and match with Turn14 items
    console.log("🔄 Processing products and matching with Turn14 items...");
    
    // Process in smaller batches to avoid overwhelming the API
    const batchSize = 50;
    
    for (let i = 0; i < productsWithT14Code.length; i += batchSize) {
      const batch = productsWithT14Code.slice(i, i + batchSize);
      console.log(`\n🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(productsWithT14Code.length / batchSize)}`);
      
      for (const product of batch) {
        try {
          // Look for this t14_code in Turn14 items map
          const turn14Item = turn14ItemsMap.get(product.t14_code.toLowerCase());
          
          if (!turn14Item) {
            skippedCount++;
            continue; // No match found in Turn14
          }

          matchedCount++;
          console.log(`✅ [${matchedCount}] Found match: ${product.sku} (${product.t14_code}) → Turn14 ID: ${turn14Item.id}`);

          // ✅ Step 4: Get pricing and inventory using the Turn14 ID
          const [pricingResult, inventoryResult] = await Promise.all([
            turn14Service.pricing.getItemPricing(turn14Item.id),
            turn14Service.inventory.getItemInventory(turn14Item.id)
          ]);

          let vendorCost = null;
          let vendorInventory = null;
          let inventoryData = null;

          // Process pricing data
          if (pricingResult && pricingResult.data) {
            const pricing = pricingResult.data;
            vendorCost = pricing.cost || pricing.map_price || pricing.retail_price || 0;
          }

          // Process inventory data  
          if (inventoryResult && inventoryResult.data && inventoryResult.data.length > 0) {
            const inventory = inventoryResult.data[0]; // First item in array
            
            // Calculate total inventory across all locations
            let totalInventory = 0;
            if (inventory.inventory && Array.isArray(inventory.inventory)) {
              totalInventory = inventory.inventory.reduce((sum, inv) => sum + (inv.quantity || 0), 0);
            }
            
            vendorInventory = totalInventory;
            inventoryData = {
              turn14_id: turn14Item.id,
              part_number: turn14Item.part_number,
              brand: turn14Item.brand,
              inventory_details: inventory.inventory || [],
              total_inventory: totalInventory,
              updated_at: new Date().toISOString()
            };
          }

          // ✅ Step 5: Create or update VendorProduct record
          const existingVendorProduct = await prisma.vendorProduct.findFirst({
            where: {
              vendor_sku: turn14Item.part_number,
              vendor_id: 15,
              product_sku: product.sku
            },
          });

          const vendorProductData = {
            vendor_cost: vendorCost,
            vendor_inventory: vendorInventory,
            vendor_inventory_string: inventoryData ? JSON.stringify(inventoryData) : null,
            updated_at: new Date()
          };

          if (existingVendorProduct) {
            // Update existing vendor product
            await prisma.vendorProduct.update({
              where: { id: existingVendorProduct.id },
              data: vendorProductData,
            });
            vendorProductUpdatedCount++;
          } else {
            // Create new vendor product
            await prisma.vendorProduct.create({
              data: {
                vendor_sku: turn14Item.part_number,
                vendor_id: 15,
                product_sku: product.sku,
                ...vendorProductData,
              },
            });
            vendorProductCreatedCount++;
          }

        } catch (error) {
          console.log(`❌ Error processing product ${product.sku}:`, error.message);
          errorCount++;
        }
      }
      
      // Add a small delay between batches
      if (i + batchSize < productsWithT14Code.length) {
        console.log("⏸️ Waiting 1 second before next batch...");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // ✅ Final Summary
    console.log("\n🎉 Turn14 vendor seeding completed!");
    console.log(`📊 Summary:`);
    console.log(`   Products processed: ${productsWithT14Code.length}`);
    console.log(`   Matched with Turn14: ${matchedCount}`);
    console.log(`   Skipped (no match): ${skippedCount}`);
    console.log(`   Vendor products created: ${vendorProductCreatedCount}`);
    console.log(`   Vendor products updated: ${vendorProductUpdatedCount}`);
    console.log(`   Errors: ${errorCount}`);
    
    console.timeEnd("Turn14 Seeding");

  } catch (error) {
    console.error("🚨 Critical error in Turn14 seeding:", error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
};

// Run the seeding function
seedTurn14VendorProducts()
  .then(() => {
    console.log("💥 Turn14 seeding process completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Turn14 seeding failed:", error);
    process.exit(1);
  });

module.exports = seedTurn14VendorProducts;