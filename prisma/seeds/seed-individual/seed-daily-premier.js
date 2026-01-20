/**
 * Premier Performance Daily Seeding Script
 * Updates pricing and inventory for all products with premier_code
 */

require('dotenv').config();
const { PrismaClient } = require("@prisma/client");
const PremierService = require("../../../services/premier");

const prisma = new PrismaClient();

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
    
    // Filter out invalid codes (ending with dash, too short, etc.)
    const premierCodes = allPremierCodes.filter(code => {
      if (!code || code.length < 5) return false;           // Too short
      if (code.endsWith('-')) return false;                 // Incomplete code
      if (code.includes('--')) return false;                // Double dash
      return true;
    });
    
    console.log(`Found ${allPremierCodes.length} total codes, filtered to ${premierCodes.length} valid codes`);
    console.log(`Processing ${premierCodes.length} unique Premier codes\n`);
    
    // Initialize counters
    let totalProcessed = 0;
    let successfulUpdates = 0;
    let createdRecords = 0;
    let updatedRecords = 0;
    let skippedZeroCost = 0;
    let errors = [];
    
    // Process in batches of 10 (Premier API fails with larger batches)
    const batchSize = 10;
    
    for (let i = 0; i < premierCodes.length; i += batchSize) {
      const batch = premierCodes.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(premierCodes.length / batchSize);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);
      
      try {
        // Get batch data from Premier API
        const batchResult = await premier.getBatchProductInfo(batch);
        
        if (!batchResult.success) {
          console.error(`Batch ${batchNum} failed:`, batchResult.error);
          errors.push(`Batch ${batchNum}: ${batchResult.error}`);
          continue;
        }
        
        // Process each item in the batch
        for (const result of batchResult.results) {
          try {
            totalProcessed++;
            
            if (!result.success) {
              console.log(`  ⚠️ ${result.itemNumber}: ${result.errors.join(', ')}`);
              continue;
            }
            
            // Find the product that has this premier_code
            const matchingProducts = await prisma.product.findMany({
              where: {
                premier_code: result.itemNumber
              },
              select: {
                sku: true,
                name: true,
                premier_code: true
              }
            });
            
            if (matchingProducts.length === 0) {
              console.log(`  ⚠️ No product found with premier_code: ${result.itemNumber}`);
              continue;
            }
            
            // Only process products with cost greater than zero
            if (result.pricing.cost > 0) {
              // Process each matching product (usually just one)
              for (const product of matchingProducts) {
                // Check if VendorProduct record exists
                const existingVendorProduct = await prisma.vendorProduct.findFirst({
                  where: {
                    product_sku: product.sku,
                    vendor_id: premierVendor.id,
                    vendor_sku: result.itemNumber
                  }
                });
                
                const vendorData = {
                  product_sku: product.sku,
                  vendor_id: premierVendor.id,
                  vendor_sku: result.itemNumber,
                  vendor_cost: result.pricing.cost * 1.5, // Apply 1.5x exchange rate
                  vendor_inventory: result.inventory.quantity || 0
                };
                
                if (existingVendorProduct) {
                  // Update existing record
                  await prisma.vendorProduct.update({
                    where: { id: existingVendorProduct.id },
                    data: {
                      vendor_cost: result.pricing.cost * 1.5, // Apply 1.5x exchange rate
                      vendor_inventory: vendorData.vendor_inventory
                    }
                  });
                  updatedRecords++;
                  console.log(`  ✅ Updated: ${product.sku} -> ${result.itemNumber} - Cost: $${result.pricing.cost} → CAD $${(result.pricing.cost * 1.5).toFixed(2)}, Qty: ${result.inventory.quantity}`);
                } else {
                  // Create new record
                  await prisma.vendorProduct.create({
                    data: vendorData
                  });
                  createdRecords++;
                  console.log(`  ➕ Created: ${product.sku} -> ${result.itemNumber} - Cost: $${result.pricing.cost} → CAD $${(result.pricing.cost * 1.5).toFixed(2)}, Qty: ${result.inventory.quantity}`);
                }
              }
              successfulUpdates++;
            } else {
              console.log(`  ⚠️ Skipped: ${result.itemNumber} - No pricing available (Cost: $0)`);
              skippedZeroCost++;
            }
            
          } catch (error) {
            console.error(`  ❌ Error processing ${result.itemNumber}:`, error.message);
            errors.push(`${result.itemNumber}: ${error.message}`);
          }
        }
        
        // Rate limiting between batches
        if (i + batchSize < premierCodes.length) {
          console.log("  Waiting 2 seconds before next batch...\n");
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        console.error(`Batch ${batchNum} processing error:`, error.message);
        errors.push(`Batch ${batchNum}: ${error.message}`);
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