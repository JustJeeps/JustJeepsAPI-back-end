const prisma = require("../../../lib/prisma");
const quadratecCost = require("../api-calls/quadratec-excel.js");

// // seed Quadratec products
const seedQuadratec = async () => {
  try {
    // Call QuadratecAPI and get the processed responses
    const vendorProductsData = await quadratecCost();
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // // ✅ Step 0: Clear old vendor products for Quadratec
    // await prisma.vendorProduct.deleteMany({ where: { vendor_id: 4 } });
    // console.log("🗑️ Deleted all existing Quadratec vendor products (vendor_id = 4)");

    // Loop through the vendorProductsData array and create vendor products
    for (const data of vendorProductsData) {
      // console.log("data", data);

      // Check if a vendor product with the same vendor_sku already exists

      
        // 1) lookup scoped by vendor
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_id: 4,                 // Quadratec
            vendor_sku: data.quadratec_code,
          },
        });

        if (existingVendorProduct) {
          vendorProductUpdatedCount++;
          console.log(`[Quadratec] ${data.quadratec_code} exists for vendor_id=4, updating...`);
          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },   // << use the SAME var
            data: {
              vendor_id: 4,                            // reassert (safe)
              vendor_sku: data.quadratec_code,
              vendor_cost: +(data.wholesalePrice * 1.5).toFixed(2),
              quadratec_sku: data.quadratec_sku,
            },
          });
          continue;
        }


      // if (existingCompetitorProduct) {
      //   vendorProductUpdatedCount++;
      //   // console.log(
      //   //   `Vendor product with vendor_sku: ${data['Part Number']} already exists, updating...`
      //   // );
      //   console.log(`Vendor product with vendor_sku: ${data.quadratec_code} already exists, updating...`);

      //   // Update the existing vendor product with new data
      //   await prisma.vendorProduct.update({
      //     where: {
      //       id: existingCompetitorProduct.id, // assuming there's an 'id' field as the primary key
      //     },
      //     data: {
      //       vendor_sku: data.quadratec_code, // Update with new vendor_sku
      //       vendor_cost: data.wholesalePrice * 1.5, // Update with new vendor_cost
      //       quadratec_sku: data.quadratec_sku, // Update with new quadratec_sku
      //       // Add any other fields that you want to update
      //     },
      //   });

      //   // console.log(
      //   //   `Vendor product with vendor_sku: ${data['Part Number']} updated successfully`
      //   // );
      //   continue; // Move to next iteration
      // }

      // Retrieve the product_sku from the Product table using meyer_code as reference
      let product; // Update: Declare product variable here
      product = await prisma.product.findFirst({
        where: {
          quadratec_code: data.quadratec_code, // Update: Access 'Part Number' key from data object
        },
      });
      // console.log("product", product);

      if (!product) {
        console.error(
          `Product not found for Quadratec_code: ${data.quadratec_code}`
        );
        continue;
      }

      // Update the data with the retrieved product_sku and vendor_id

      //   const hasNoInventoryInfo =
      //   (data.vendor_inventory === null || data.vendor_inventory === undefined) &&
      //   !data.vendor_inventory_string;
      
      //   const vendorProductData = {
      //     product_sku: product.sku,
      //     vendor_id: 4,
      //     vendor_sku: data.quadratec_code,
      //     vendor_cost: data.wholesalePrice * 1.5,
      //     quadratec_sku: data.quadratec_sku,
      //     vendor_inventory: data.vendor_inventory,
      //     vendor_inventory_string: hasNoInventoryInfo ? "no info" : data.vendor_inventory_string,
      // };
    

      const vendorProductData = {
        product_sku: product.sku, // Updated with the correct product SKU',
        vendor_id: 4, // Updated with the correct vendor ID
        vendor_sku: data.quadratec_code, // Extracted from API response
        //2 decimal places for vendor_cost
        vendor_cost: data.wholesalePrice * 1.5, // Extracted from API response
        // vendor_cost: data.wholesalePrice*1.40, // Extracted from API response
        quadratec_sku: data.quadratec_sku, // Update with new quadratec_sku
        // Add any other fields that you want to create
      };

      

      // Create the vendor product
      await prisma.vendorProduct.create({
        data: vendorProductData,
      });
      vendorProductCreatedCount++;
    }

    // console.log("Vendor products from Quadratec seeded successfully!");
    // console.log(`Total vendor products created: ${vendorProductCreatedCount}`);
    // console.log(`Total vendor products updated: ${vendorProductUpdatedCount}`);
    console.log(`Vendor products from Quadratec seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}, 
      Total vendor products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from Quadratec:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedQuadratec();
module.exports = seedQuadratec;
