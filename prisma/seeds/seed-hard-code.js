const { PrismaClient } = require("@prisma/client");
const vendorsData = require("./hard-code_data/vendors_data");
const vendorsPrefix = require("./hard-code_data/vendors_prefix");
const userData = require("./hard-code_data/users_data.js");
const competitorData = require("./hard-code_data/competitors_data.js");
// const ordersData = require("./hard-code_data/orders_data.js");
// const productsData = require("./hard-code_data/products_data.js");
// const meyerData = require("./hard-code_data/meyer_cost.js");
// const keystoneData = require("./hard-code_data/keystone_data.js");
// const seedNorthridge = require("./seed-individual/seed-northridge.js");
// const seedOmix = require("./seed-individual/seed-omix.js");

const prisma = new PrismaClient();

//  Order of seeding:
//1. Seed users
//2. Sees competitors info
//3. Seed vendors Info
//4. Seed all products
//5. Seed all orders and order products
//6. Seed all vendors products (meyer, keystone, omix)

const allseeds = async () => {
  try {
    console.time("allseeds"); // Start the timer for allseeds

    await seedUsers();
    await seedCompetitorsInfo();
    await seedVendorsInfo();

    // console.time("seedAllProducts");
    // console.log("Seeding all products...");
    // await seedAllProducts();
    // console.timeEnd("seedAllProducts");

    // console.log("Seeding orders...");
    // await seedOrders();

    // console.log("Seeding Omix...");
    // await seedOmix();

    // console.log("Seeding Meyer...");
    // await seedMeyer();

    // console.log("Seeding Keystone...");
    // await seedKeystone();

    // console.log("Seeding Northridge Competition...");
    // await seedNorthridge();

    console.timeEnd("allseeds"); // End the timer for allseeds
    console.log("All seeds complete");
  } catch (error) {
    console.error("Error seeding data:", error);
  }
};

// Seed users
const seedUsers = async () => {
  try {
    for (const user of userData) {
      // Check if a user with the same email already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          email: user.email,
        },
      });

      if (existingUser) {
        // console.error(`User with email "${user.email}" already exists`);
        continue;
      }

      // Create the user
      await prisma.user.create({ data: user });
      // console.log(`User "${user.email}" created.`);
    }
    console.log("Users seeded successfully!");
  } catch (error) {
    console.error("Error seeding data:", error);
  } finally {
    await prisma.$disconnect();
  }
};

// seed competitors info
const seedCompetitorsInfo = async () => {
  try {
    for (const competitor of competitorData) {
      // Check if a competitor with the same name already exists
      const existingCompetitor = await prisma.competitor.findFirst({
        where: {
          name: competitor.name,
        },
      });

      if (existingCompetitor) {
        // console.error(`Competitor with name "${competitor.name}" already exists`);
        continue; // Remove this line if you don't want to seed
      }

      // Create the competitor
      await prisma.competitor.create({ data: competitor });
      // console.log(`Competitor "${competitor.name}" created.`);
    }
    console.log("Competitors seeded successfully!");
  } catch (error) {
    console.error("Error seeding data:", error);
  }
};

// seed vendors info
const seedVendorsInfo = async () => {
  try {
    for (const vendor of vendorsData) {
      // Check if a vendor with the same name already exists
      const existingCompetitor = await prisma.vendor.findFirst({
        where: {
          name: vendor.name,
        },
      });

      if (existingCompetitor) {
        // console.error(`Vendor with name "${vendor.name}" already exists`);
        continue; // Remove this line if you don't want to seed
      }

      // Create the vendor
      await prisma.vendor.create({ data: vendor });
      // console.log(`Vendor "${vendor.name}" created.`);
    }
    console.log("Vendors seeded successfully!");
  } catch (error) {
    console.error("Error seeding data:", error);
  }
};

const seedAllProducts = async () => {
  try {
    // Initialize counters for created and updated products
    let createdCount = 0;
    let updatedCount = 0;

    for (const item of productsData) {
      const {
        sku,
        status,
        name,
        price,
        weight,
        media_gallery_entries,
        custom_attributes,
      } = item;
      // console.log("item", item);

      // Extract jj_prefix from sku by splitting at the first hyphen and taking the first element
      const jjPrefix = item.sku.split("-")[0];

      // Extract searchable_sku from sku by removing characters before the first hyphen
      const searchable_sku = item.sku.slice(item.sku.indexOf("-") + 1);

      // Get the vendor data based on jj_prefix
      const vendorData = vendorsPrefix.find(
        (vendor) => vendor.jj_prefix === jjPrefix
      );

      // Generate meyer_code, keystone_code, and brand_name based on vendor data
      const meyerCode =
        vendorData && vendorData.meyer_code
          ? vendorData.meyer_code + searchable_sku
          : "";

      //Generate keystone_code based on vendor data
      const keystoneCode =
        vendorData && vendorData.keystone_code
          ? vendorData.keystone_code + searchable_sku.replace(/-/g, "")
          : "";

      //Generate brand_name based on vendor data
      const brandName = vendorData ? vendorData.brand_name : "";

      // Generate vendors based on vendor data
      const vendors = vendorData ? vendorData.vendors : "";

      const searchableSku =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "searchable_sku") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      const url_path =
        custom_attributes &&
        Object.keys(custom_attributes).reduce((acc, key) => {
          if (custom_attributes[key].attribute_code === "url_path") {
            return custom_attributes[key].value || "";
          }
          return acc;
        }, "");

      // console.log("check sku", sku);
      //console.log the product when sku is undefined
      if (sku === undefined) {
        // console.log("check item", item);
      }
      // Check if product with given SKU already exists in the database
      const existingProduct = await prisma.product.findUnique({
        where: { sku },
      });

      if (existingProduct) {
        // Update existing product
        await prisma.product.update({
          where: { sku },
          data: {
            name,
            status,
            price,
            weight,
            searchableSku,
            searchable_sku,
            jj_prefix: jjPrefix,
            meyer_code: meyerCode,
            keystone_code: keystoneCode,
            omix_code:
              jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR"
                ? searchable_sku
                : null,
            brand_name: brandName,
            vendors: vendors,
            // manufacturer_code: manufacturerCode,
            image:
              media_gallery_entries && media_gallery_entries.length > 0
                ? `https://www.justjeeps.com/pub/media/catalog/product/${
                    media_gallery_entries[0]?.file || null
                  }`
                : null,
            url_path: `https://www.justjeeps.com/${url_path || null}`,
          },
        });
        // console.log(`Product with SKU ${sku} updated.`);
        updatedCount++; // Increment updated product counter
      } else {
        // Create new product
        // console.log("check sku", sku);
        await prisma.product.create({
          data: {
            sku,
            status,
            name,
            price,
            weight,
            searchableSku,
            searchable_sku,
            jj_prefix: jjPrefix,
            meyer_code: meyerCode,
            keystone_code: keystoneCode,
            omix_code:
              jjPrefix === "OA" || jjPrefix === "ALY" || jjPrefix === "RR"
                ? searchable_sku
                : null,
            brand_name: brandName,
            vendors: vendors,
            // manufacturer_code: manufacturerCode,
            image:
              media_gallery_entries && media_gallery_entries.length > 0
                ? `https://www.justjeeps.com/pub/media/catalog/product/${
                    media_gallery_entries[0]?.file || null
                  }`
                : null,
            url_path: `https://www.justjeeps.com/${url_path || null}`,
          },
        });
        // console.log(`Product with SKU ${sku} created.`);
        createdCount++; // Increment created product counter
      }
    }

    console.log(`Products seeded successfully!! 
    Total products created: ${createdCount}
    Total products updated: ${updatedCount}`);
  } catch (error) {
    console.error("Error seeding data:", error);
  } finally {
    await prisma.$disconnect();
  }
};

// // seed orders
const seedOrders = async () => {
  try {
    let orderCount = 0;

    // Seed orders
    for (const orderData of ordersData.items) {
      orderCount++;
      const { entity_id, items, ...order } = orderData;
      const existingOrder = await prisma.order.findUnique({
        where: { entity_id },
      });

      if (!existingOrder) {
        try {
          // Use try-catch block to catch errors while seeding each order
          const createdOrder = await prisma.order.create({
            data: { ...order, entity_id },
          });

          // Seed order products
          for (const itemData of items) {
            await prisma.orderProduct.create({
              data: {
                ...itemData,
                order_id: createdOrder.entity_id, // Use entity_id as order_id
                sku: itemData.sku,
              },
            });
          }
        } catch (error) {
          // console.error(
          //   `Error seeding order with entity_id ${entity_id}:`,
          //   error.code
          // );
          // Continue to next order even if error occurs
          continue;
        }
      } else {
        try {
          // If order already exists, update its properties
          const updatedOrder = await prisma.order.update({
            where: { entity_id },
            data: { ...order },
          });
          // console.log(`Order with entity_id ${entity_id} already exists. Updating...`);
        } catch (error) {
          console.error(
            `Error updating order with entity_id ${entity_id}:`,
            error.code
          );
          // Continue to next order even if error occurs
          continue;
        }
      }
    }

    console.log("Orders seeded successfully");
    console.log(`Total orders seeded: ${orderCount}`);
  } catch (error) {
    console.error("Error seeding data:", error);
  }
};

const seedMeyer = async () => {
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // Loop through the vendorProductsData array and create/update vendor products
    for (const data of meyerData) {
      // console.log("counter", counter);
      try {
        //if data = { statusCode: 500, errorCode: 40501, errorMessage: 'No results found' } skip to next iteration
        if (data.statusCode) {
          // console.error(`No results found for vendor_sku`);
          continue; // Skip to next iteration
        }

        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data.vendor_sku,
          },
        });

        if (existingVendorProduct) {
          // console.log(
          //   `Vendor product with vendor_sku: ${data.vendor_sku} already exists, updating...`
          // );
          vendorProductUpdatedCount++; // Increment the updated count
          // Update the existing vendor product with new data
          await prisma.vendorProduct.update({
            where: {
              id: existingVendorProduct.id,
            },
            data: {
              vendor_sku: data.vendor_sku,
              vendor_cost: data.vendor_cost,
              vendor_inventory: data.vendor_inventory,
              // Add any other fields that you want to update
            },
          });

          // console.log(
          //   `Vendor product with vendor_sku: ${data.vendor_sku} updated successfully`
          // );
          // Increment the counter for updated vendor products
          continue; // Move to next iteration
        }

        // Retrieve the product_sku from the Product table using meyer_code as reference
        let product;
        product = await prisma.product.findFirst({
          where: {
            meyer_code: data.vendor_sku,
          },
        });

        if (!product) {
          console.error(`Product not found for meyer_code: ${data.vendor_sku}`);
          continue; // Skip to next iteration
        }

        // Update the data with the retrieved product_sku and vendor_id
        const vendorProductData = {
          product_sku: product.sku,
          vendor_id: 2,
          vendor_sku: data.vendor_sku,
          vendor_cost: data.vendor_cost,
          vendor_inventory: data.vendor_inventory,
        };
        vendorProductCreatedCount++; // Increment the created count
        // Create the vendor product
        await prisma.vendorProduct.create({
          data: vendorProductData,
        });

        // console.log("created vendor product from Meyer: ", vendorProductData);
      } catch (error) {
        console.error(`Error processing vendor_sku :`, error);
        // You can choose to continue to the next iteration or handle the error as needed
      }
    }

    console.log(`Meyer vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding vendor products from Meyer:", error);
  } finally {
    await prisma.$disconnect();
  }
};

// Seed Keystone  products
const seedKeystone = async () => {
  try {
    let vendorProductCreatedCount = 0;
    let vendorProductUpdatedCount = 0;

    // Loop through the vendorProductsData object and create/update vendor products
    for (const data of keystoneData) {
      // console.log("item", data);
      try {
        // Check if a vendor product with the same vendor_sku already exists
        const existingVendorProduct = await prisma.vendorProduct.findFirst({
          where: {
            vendor_sku: data.vendor_sku,
          },
        });

        if (existingVendorProduct) {
          // Vendor product already exists, update it

          // Update the existing vendor product with the retrieved values and other data
          const updatedVendorProductData = {
            product_sku: existingVendorProduct.product_sku,
            vendor_id: 1,
            vendor_sku: data.vendor_sku,
            vendor_cost: data.vendor_cost,
            vendor_inventory: data.vendor_inventory,
          };

          await prisma.vendorProduct.update({
            where: { id: existingVendorProduct.id },
            data: updatedVendorProductData,
          });

          vendorProductUpdatedCount++; // Increment the updated count

          //console.log to show the updated vendor product
          // console.log(`Vendor product with vendor_sku ${data.vendor_sku} updated successfully!`);
        } else {
          // Vendor product doesn't exist, create it
          // console.log("vendor sku", data.vendor_sku)
          const product = await prisma.product.findFirst({
            where: {
              keystone_code: data.vendor_sku,
            },
          });
          // console.log("product", product);

          // console.log("product sku", product.sku)
          const newVendorProductData = {
            product_sku: product.sku,
            vendor_id: 1,
            vendor_sku: data.vendor_sku,
            vendor_cost: data.vendor_cost,
            vendor_inventory: data.vendor_inventory,
          };

          await prisma.vendorProduct.create({
            data: newVendorProductData,
          });

          vendorProductCreatedCount++; // Increment the created count

          //console.log to show the created vendor product
          // console.log(`Vendor product with vendor_sku ${keystoneCode} created successfully!`);
        }
      } catch (error) {
        // console.error("Error seeding Keystone vendor products:", error);
        continue; // Continue to next order even if error occurs
      }
    }

    console.log(`Keystone vendor products seeded successfully! 
      Total vendor products created: ${vendorProductCreatedCount}
      Total vendor products updated: ${vendorProductUpdatedCount}`);
  } catch (error) {
    console.error("Error seeding Keystone vendor products:", error);
  } finally {
    await prisma.$disconnect();
  }
};

allseeds();
