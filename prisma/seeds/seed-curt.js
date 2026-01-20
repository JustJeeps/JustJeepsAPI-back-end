const { PrismaClient } = require("@prisma/client");
const curtCost = require("./api-calls/curt.js");

const prisma = new PrismaClient();

// Get Curt vendor ID - from vendors_data.js
const CURT_VENDOR_ID = 14; // Based on vendors_data.js, Curt is the 14th vendor

const seedCurtVendorProducts = async () => {
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;
    let skippedCount = 0;
    let matchedProductsCount = 0;

    //delete all existing Curt vendor products first
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: CURT_VENDOR_ID } });
    console.log(`🗑️ Deleted all existing Curt vendor products (vendor_id = ${CURT_VENDOR_ID})`);

    console.log("🚀 Starting Curt vendor products seeding...");

    // ✅ Step 0: Clear old vendor products for Curt
    await prisma.vendorProduct.deleteMany({ where: { vendor_id: CURT_VENDOR_ID } });
    console.log(`🗑️ Deleted all existing Curt vendor products (vendor_id = ${CURT_VENDOR_ID})`);

    // Call curtCost and get the processed data
    const curtProductsData = await curtCost();
    console.log(`📊 Found ${curtProductsData.length} products from Curt Excel file`);

    // Group products by brand for summary
    const brandCounts = {};
    curtProductsData.forEach(product => {
      brandCounts[product.BrandName] = (brandCounts[product.BrandName] || 0) + 1;
    });
    console.log("📋 Products by brand:", brandCounts);

    // Loop through the curtProductsData array and create vendor products
    for (const data of curtProductsData) {
      try {
        // Skip if no required data
        if (!data.Item || data.Cost === undefined) {
          console.log(`⚠️ Skipping item with missing data:`, data);
          skippedCount++;
          continue;
        }

        // STEP 1: Check if vendor product already exists with exact vendor_sku match
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data.Item,
            vendor_id: CURT_VENDOR_ID
          },
          include: {
            product: true
          }
        });

        if (existingVendorProduct) {
          // Update existing vendor product with new cost
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: {
              vendor_cost: data.Cost * 1.50, // Convert USD to CAD with 1.50 exchange rate
              manufacturer_sku: data.Item,
              // vendor_inventory: 999, // No inventory info available from Curt
              // vendor_inventory_string: "In Stock"
            },
          });
          vendorProductUpdatedCount++;
          
          // NOTE: We do NOT update brand names from Excel file
          // Keep existing database brand names as-is
          continue;
        }

        // STEP 2: Try to find matching product by SKU AND brand
        // We match products from the 4 specific brands: Aries Automotive, Curt Manufacturing, Luverne, UWS Storage
        // NOTE: Brand name in Excel must match brand_name in database (with some flexibility)
        let matchingProduct = null;
        
        // Map Excel brand names to possible database brand name variations
        const brandNameVariations = {
          'ARIES Automotive': ['ARIES Automotive', 'Aries Automotive', 'ARIES'],
          'CURT Manufacturing': ['CURT Manufacturing', 'Curt Manufacturing', 'CURT', 'Curt'],
          'LUVERNE Truck Equipment': ['LUVERNE Truck Equipment', 'Luverne Truck Equipment', 'LUVERNE', 'Luverne'],
          'UWS Storage Solutions': ['UWS Storage Solutions', 'UWS Storage', 'UWS']
        };
        
        const possibleBrandNames = brandNameVariations[data.BrandName] || [data.BrandName];
        
        // Strategy 1: Match by brand AND searchable_sku (most reliable)
        matchingProduct = await prisma.product.findFirst({
          where: {
            AND: [
              { brand_name: { in: possibleBrandNames, mode: 'insensitive' } },
              {
                OR: [
                  { searchableSku: { equals: data.Item, mode: 'insensitive' } },
                  { searchable_sku: { equals: data.Item, mode: 'insensitive' } }
                ]
              }
            ]
          }
        });

        // Strategy 2: Match by brand AND SKU ending with item number
        if (!matchingProduct) {
          matchingProduct = await prisma.product.findFirst({
            where: {
              AND: [
                { brand_name: { in: possibleBrandNames, mode: 'insensitive' } },
                { sku: { endsWith: `-${data.Item}`, mode: 'insensitive' } }
              ]
            }
          });
        }

        // Strategy 3: Broader match - brand AND SKU contains (use with caution)
        if (!matchingProduct) {
          matchingProduct = await prisma.product.findFirst({
            where: {
              AND: [
                { brand_name: { in: possibleBrandNames, mode: 'insensitive' } },
                { sku: { contains: data.Item, mode: 'insensitive' } }
              ]
            }
          });
        }

        if (matchingProduct) {
          matchedProductsCount++;
          
          // Create new vendor product for matched product
          await prisma.vendorProduct.create({
            data: {
              product_sku: matchingProduct.sku,
              vendor_id: CURT_VENDOR_ID,
              vendor_sku: data.Item,
              vendor_cost: data.Cost * 1.50, // Convert USD to CAD with 1.50 exchange rate
              manufacturer_sku: data.Item,
              // vendor_inventory: 999, // No inventory info available from Curt
              // vendor_inventory_string: "In Stock"
            },
          });
          vendorProductCreatedCount++;

          // NOTE: We do NOT update brand names from Excel file
          // The database brand names should remain as-is (e.g., "CURT Manufacturing")
          // even if Excel shows different brands (e.g., "LIPPERT")
        } else {
          // STEP 3: Create new product for items that don't exist
          const newProductSku = `CURT-${data.Item}`;
          
          // Check if this SKU already exists
          const existingProduct = await prisma.product.findUnique({
            where: { sku: newProductSku }
          });

          if (!existingProduct) {
            await prisma.product.create({
              data: {
                sku: newProductSku,
                name: data.ItemDescription || `${data.BrandName} ${data.Item}`,
                status: 1,
                price: data.List || data.Jobber || data.Cost * 2, // Use list price or calculate markup
                MAP: data.MAP || null,
                searchableSku: data.Item,
                searchable_sku: data.Item,
                brand_name: data.BrandName,
                weight: data.Weight || null,
                vendors: "Curt"
              }
            });

            // Create vendor product for the new product
            await prisma.vendorProduct.create({
              data: {
                product_sku: newProductSku,
                vendor_id: CURT_VENDOR_ID,
                vendor_sku: data.Item,
                vendor_cost: data.Cost * 1.50, // Convert USD to CAD with 1.50 exchange rate
                manufacturer_sku: data.Item,
                // vendor_inventory: 999, // No inventory info available from Curt
                // vendor_inventory_string: "In Stock"
              },
            });
            vendorProductCreatedCount++;
          }
        }

      } catch (error) {
        console.error(`❌ Error processing item ${data.Item}:`, error.message);
        skippedCount++;
      }
    }

    console.log("\n✅ Curt vendor products seeding completed!");
    console.log(`📈 Created: ${vendorProductCreatedCount} vendor products`);
    console.log(`🔄 Updated: ${vendorProductUpdatedCount} vendor products`);
    console.log(`🔗 Matched products: ${matchedProductsCount}`);
    console.log(`⚠️ Skipped: ${skippedCount} items`);
    console.log(`📦 Total processed: ${curtProductsData.length} items`);

  } catch (error) {
    console.error("❌ Error in seedCurtVendorProducts:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
};

// If running directly, execute the function
if (require.main === module) {
  seedCurtVendorProducts()
    .then(() => {
      console.log("🎉 Curt seeding process completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Curt seeding process failed:", error);
      process.exit(1);
    });
}

module.exports = seedCurtVendorProducts;