const { PrismaClient } = require("@prisma/client");
const vendorsData = require("./hard-code_data/vendors_data");
const userData = require("./hard-code_data/users_data.js");
const competitorData = require("./hard-code_data/competitors_data.js");
const magentoRecentOrders = require("./api-calls/magento-recentOrders.js");
const seedAllProducts = require("../seeds/seed-individual/seed-allProducts.js");
const seedMeyer = require("../seeds/seed-individual/seed-meyer.js");
const seedKeystone = require("../seeds/seed-individual/seed-keystone.js");
const seedOmix = require("./seed-individual/seed-omix.js");


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

    console.log("Seeding all products...");
    console.time("seedAllProducts");
    await seedAllProducts();
    console.timeEnd("seedAllProducts"); // End the timer for seedAllProducts

    console.log("Seeding orders...");
    console.time("seedOrders");
    await seedOrders();
    console.timeEnd("seedOrders"); // End the timer for seedOrders
    
    console.log("Seeding Omix...");
    console.time("seedOmix");
    await seedOmix();
    console.timeEnd("seedOmix"); // End the timer for seedOmix

    console.log("Seeding Meyer...");
    console.time("seedMeyer");
    await seedMeyer();
    console.timeEnd("seedMeyer"); // End the timer for seedMeyer

    console.log("Seeding Keystone...");
    console.time("seedKeystone");
    await seedKeystone(); 
    console.timeEnd("seedKeystone"); // End the timer for seedKeystone

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

// // seed orders
const seedOrders = async () => {
  try {
    // Fetch orders from API
    const response = await magentoRecentOrders(1000);

    const orders = response.data.items;
    let orderCount = 0;

    // Seed orders
    for (const orderData of orders) {
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
          console.error(
            `Error seeding order with entity_id ${entity_id}:`,
            error.code
          );
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
          console.log(`Order with entity_id ${entity_id} already exists. Updating...`);
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


allseeds();
