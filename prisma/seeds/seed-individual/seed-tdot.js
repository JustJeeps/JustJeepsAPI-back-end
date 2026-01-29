const tdotCost = require("../api-calls/tdot-api.js");

const prisma = require("../../../lib/prisma");

// Seed Tdot competitor products
const seedTdot = async () => {
  try {

    // console.log("🗑️ Deleting old Tdot competitor products...");
    // await prisma.competitorProduct.deleteMany({
    //   where: { competitor_id: 4 }
    // });
    // console.log("✅ All previous Tdot competitor products deleted");
    
    
    const competitorProductsData = await tdotCost();
    console.log(`Total competitor products to process: ${competitorProductsData.length}`);

    let competitorProductCreatedCount = 0;
    let competitorProductUpdatedCount = 0;


    for (const data of competitorProductsData) {
      try {
        const product = await prisma.product.findFirst({
          where: {
            tdot_code: data.tdot_code, // Find the product by tdot_code
          },
        });

        if (!product) {
          console.error(`Product not found for tdot_code: ${data.tdot_code}`);
          continue;
        }

        // Check if a competitor product already exists with the same competitor_sku (tdot_code)
        const existingCompetitorProduct = await prisma.competitorProduct.findFirst({
          where: {
            competitor_sku: data.tdot_code, // Check if competitor_sku (tdot_code) already exists
            competitor_id: 4, // Ensure competitor_id is 4 (Tdot competitor)
          },
        });

        if (existingCompetitorProduct) {
          competitorProductUpdatedCount++;
          
          // Update only necessary fields, preserving competitor_sku (tdot_code)
          await prisma.competitorProduct.update({
            where: {
              id: existingCompetitorProduct.id,
            },
            data: {
              competitor_price: data.tdot_price*0.9, // Update competitor price
              product_url: data.product_url || null, // Update product URL if available
            },
          });

          continue; // Skip to next iteration after updating
        }

        // If no existing competitor product, create a new one
        console.log(`Creating new competitor product for SKU: ${product.sku}`);
        await prisma.competitorProduct.create({
          data: {
            product_sku: product.sku, // Link to product's SKU
            competitor_id: 4, // Set competitor ID to 4 (for Tdot)
            competitor_price: data.tdot_price*0.9, // Set competitor price
            competitor_sku: data.tdot_code, // Use tdot_code as competitor_sku
            product_url: data.product_url || null, // Optional product URL if available
          },
        });

        competitorProductCreatedCount++;

      } catch (error) {
        console.error(`Error processing tdot_code: ${data.tdot_code}: ${error.message}`);
        continue;
      }
    }

    console.log(`Competitor products from Tdot seeded successfully! 
      Total competitor products created: ${competitorProductCreatedCount}, 
      Total competitor products updated: ${competitorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding competitor products from Tdot:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedTdot();
module.exports = seedTdot;
