const prisma = require("../../../lib/prisma");
const tdotCost = require("../api-calls/tdot-excel.js"); // Ensure this file exports the correct data

// Seed Tdot products
const seedTdot = async () => {
  try {
    // Call TdotAPI and get the processed responses
    const competitorProductsData = await tdotCost();
    console.log(`Total competitor products to process: ${competitorProductsData.length}`); // Log total products to process

    let competitorProductCreatedCount = 0;
    let competitorProductUpdatedCount = 0;

    // Loop through the competitorProductsData array and create competitor products
    for (const data of competitorProductsData) {
      try {
        // Retrieve the product based on the tdot_code
        const product = await prisma.product.findFirst({
          where: {
            tdot_code: data.tdot_code, // Access the tdot_code key from the data object
          },
        });

        if (!product) {
          console.error(`Product not found for tdot_code: ${data.tdot_code}`);
          continue; // Skip to the next iteration if the product is not found
        }

        // Check if a competitor product with the same product_sku already exists
        const existingCompetitorProduct = await prisma.competitorProduct.findFirst({
          where: {
            product_sku: product.sku, // Use the product SKU from the found product
          },
        });

        if (existingCompetitorProduct) {
          competitorProductUpdatedCount++;
          
          // Log the id of the existing competitor product being updated
          console.log(`Updating competitor product with ID: ${existingCompetitorProduct.id} for SKU: ${product.sku}`);

          // Update the existing competitor product with new data, ensuring competitor_id = 4
          await prisma.competitorProduct.update({
            where: {
              id: existingCompetitorProduct.id,
            },
            data: {
              competitor_price: data.tdot_price, // Ensure this value is provided in the data
              competitor_id: 4, // Ensure the competitor_id is set to 4
              // Add any other fields you want to update
            },
          });
          
          continue; // Move to the next iteration
        }

        // Create the new competitor product
        console.log(`Creating new competitor product for SKU: ${product.sku}`);
        await prisma.competitorProduct.create({
          data: {
            product_sku: product.sku, // Use the SKU of the found product
            competitor_id: 4, // Set competitor_id for new products
            competitor_price: data.tdot_price, // Ensure this value is provided in the data
            // Add any other fields required for creation
          },
        });
        competitorProductCreatedCount++;
      } catch (error) {
        console.error(`Error processing tdot_code: ${data.tdot_code}: ${error.message}`);
        // Continue with the next product even if there's an error
      }
    }

    console.log(`Competitor products from Tdot seeded successfully! 
      Total competitor products created: ${competitorProductCreatedCount}, 
      Total competitor products updated: ${competitorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding competitor products from Tdot:", error);
  }
};

seedTdot();
module.exports = seedTdot;
