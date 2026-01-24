const magentoRecentOrders = require("../api-calls/magento-recentOrders.js");

// Use singleton when running inside server.js, create new instance for standalone
const prisma = require('../../../lib/prisma');

// Seed orders
const seedOrders = async () => {
  try {
    // Fetch orders from API
    const response = await magentoRecentOrders(400);
    const orders = response.data.items;

    // Counters for statistics
    let orderCount = 0;
    let newOrderCount = 0;
    let updatedOrderCount = 0;
    let orderProductCount = 0;
    let skippedProductCount = 0;
    const missingSkus = new Set();

    for (const orderData of orders) {
      orderCount++;
      const { entity_id, items, extension_attributes, ...order } = orderData;

      // Extract custom attributes
      let custom_po_number = null;
      let weltpixel_fraud_score = null;
      let region = null;
      let city = null;
      let method_title = null;

      // ✅ new shipping fields
      let shipping_firstname = null;
      let shipping_lastname = null;
      let shipping_postcode = null;
      let shipping_street1 = null;
      let shipping_street2 = null;
      let shipping_street3 = null;
      let shipping_telephone = null;
      let shipping_city = null;
      let shipping_region = null;
      let shipping_country_id = null;
      let shipping_company = null;





      if (extension_attributes) {
        if (extension_attributes.amasty_order_attributes) {
          const poNumberAttribute =
            extension_attributes.amasty_order_attributes.find(
              (attr) => attr.attribute_code === "custom_po_number"
            );
          if (poNumberAttribute) {
            custom_po_number = poNumberAttribute.value;
          }
        }
        if (extension_attributes.weltpixel_fraud_score !== undefined) {
          weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
        }
        if (
          extension_attributes.shipping_assignments &&
          extension_attributes.shipping_assignments.length > 0
        ) {
          const shippingAssignment =
            extension_attributes.shipping_assignments[0];
          if (
            shippingAssignment.shipping &&
            shippingAssignment.shipping.address
          ) {
            const shippingAddress = shippingAssignment.shipping.address;
            region = shippingAddress.region;
            city = shippingAddress.city;

            // ✅ map to correct fields
            shipping_firstname = shippingAddress.firstname;
            shipping_lastname = shippingAddress.lastname;
            shipping_postcode = shippingAddress.postcode;
            shipping_street1 = shippingAddress.street?.[0] || null;
            shipping_street2 = shippingAddress.street?.[1] || null;
            shipping_street3 = shippingAddress.street?.[2] || null;
            shipping_telephone = shippingAddress.telephone;
            shipping_country_id = shippingAddress.country_id;
            shipping_city = shippingAddress.city;
            shipping_region = shippingAddress.region;
            shipping_company = shippingAddress.company;
          }
        }
        if (extension_attributes.payment_additional_info) {
          const methodTitleAttribute =
            extension_attributes.payment_additional_info.find(
              (attr) => attr.key === "method_title"
            );
          if (methodTitleAttribute) {
            method_title = methodTitleAttribute.value;
          }
        }
      }

      const orderDataWithCustomAttributes = {
        ...order,
        custom_po_number,
        weltpixel_fraud_score,
        region,
        city,
        method_title,
        shipping_firstname,
        shipping_lastname,
        shipping_postcode,
        shipping_street1,
        shipping_street2,
        shipping_street3,
        shipping_telephone,
        shipping_city,
        shipping_region,
        shipping_country_id,
        shipping_company
      };

      const existingOrder = await prisma.order.findUnique({
        where: { entity_id },
      });

      if (!existingOrder) {
        try {
          const createdOrder = await prisma.order.create({
            data: { ...orderDataWithCustomAttributes, entity_id },
          });
          newOrderCount++;

          // Create OrderProducts only for SKUs that exist in Product table
          for (const itemData of items) {
            const productExists = await prisma.product.findUnique({
              where: { sku: itemData.sku },
              select: { sku: true },
            });

            if (productExists) {
              await prisma.orderProduct.create({
                data: {
                  ...itemData,
                  order_id: createdOrder.entity_id,
                  sku: itemData.sku,
                },
              });
              orderProductCount++;
            } else {
              missingSkus.add(itemData.sku);
              skippedProductCount++;
            }
          }
        } catch (error) {
          console.error(`Error seeding new order ${entity_id}:`, error);
          continue;
        }
      } else {
        try {
          await prisma.order.update({
            where: { entity_id },
            data: { ...orderDataWithCustomAttributes },
          });
          updatedOrderCount++;

          // Delete existing OrderProducts and recreate only for valid SKUs
          await prisma.orderProduct.deleteMany({ where: { order_id: entity_id } });

          for (const itemData of items) {
            const productExists = await prisma.product.findUnique({
              where: { sku: itemData.sku },
              select: { sku: true },
            });

            if (productExists) {
              await prisma.orderProduct.create({
                data: { ...itemData, order_id: entity_id, sku: itemData.sku },
              });
              orderProductCount++;
            } else {
              missingSkus.add(itemData.sku);
              skippedProductCount++;
            }
          }
        } catch (error) {
          console.error(`Error updating order ${entity_id}:`, error);
          continue;
        }
      }
    }

    // Print summary
    console.log("\n========== SEED ORDERS SUMMARY ==========");
    console.log(`Total orders processed: ${orderCount}`);
    console.log(`  - New orders created: ${newOrderCount}`);
    console.log(`  - Orders updated: ${updatedOrderCount}`);
    console.log(`OrderProducts created: ${orderProductCount}`);
    console.log(`OrderProducts skipped (SKU not found): ${skippedProductCount}`);

    if (missingSkus.size > 0) {
      console.log(`\nMissing SKUs (${missingSkus.size} unique):`);
      const skuArray = Array.from(missingSkus).slice(0, 20);
      skuArray.forEach(sku => console.log(`  - ${sku}`));
      if (missingSkus.size > 20) {
        console.log(`  ... and ${missingSkus.size - 20} more`);
      }
    }
    console.log("==========================================\n");
  } catch (error) {
    console.error("Error during seeding:", error);
  }
};

module.exports = seedOrders;

seedOrders();




// const { PrismaClient } = require("@prisma/client");


// const magentoRecentOrders = require("../api-calls/magento-recentOrders.js");

// const prisma = new PrismaClient();

// // Seed orders
// const seedOrders = async () => {
//   try {
//     // Fetch orders from API
//     const response = await magentoRecentOrders(300);
//     const orders = response.data.items;
//     let orderCount = 0;

//     for (const orderData of orders) {
//       orderCount++;
//       const { entity_id, items, extension_attributes, ...order } = orderData;

//       // Extract custom attributes
//       let custom_po_number = null;
//       let weltpixel_fraud_score = null;
//       let region = null;
//       let city = null;
//       let method_title = null;

//       if (extension_attributes) {
//         if (extension_attributes.amasty_order_attributes) {
//           const poNumberAttribute = extension_attributes.amasty_order_attributes.find(
//             (attr) => attr.attribute_code === "custom_po_number"
//           );
//           if (poNumberAttribute) {
//             custom_po_number = poNumberAttribute.value;
//           }
//         }
//         if (extension_attributes.weltpixel_fraud_score !== undefined) {
//           weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
//         }
//         if (
//           extension_attributes.shipping_assignments &&
//           extension_attributes.shipping_assignments.length > 0
//         ) {
//           const shippingAssignment = extension_attributes.shipping_assignments[0];
//           if (shippingAssignment.shipping && shippingAssignment.shipping.address) {
//             const shippingAddress = shippingAssignment.shipping.address;
//             region = shippingAddress.region;
//             city = shippingAddress.city;
//           }
//         }
//         if (extension_attributes.payment_additional_info) {
//           const methodTitleAttribute = extension_attributes.payment_additional_info.find(
//             (attr) => attr.key === "method_title"
//           );
//           if (methodTitleAttribute) {
//             method_title = methodTitleAttribute.value;
//           }
//         }
//       }

//       const orderDataWithCustomAttributes = {
//         ...order,
//         custom_po_number,
//         weltpixel_fraud_score,
//         region,
//         city,
//         method_title,
//       };

//       const existingOrder = await prisma.order.findUnique({
//         where: { entity_id },
//       });

//       if (!existingOrder) {
//         try {
//           const createdOrder = await prisma.order.create({
//             data: { ...orderDataWithCustomAttributes, entity_id },
//           });

//           for (const itemData of items) {
//             await prisma.orderProduct.create({
//               data: {
//                 ...itemData,
//                 order_id: createdOrder.entity_id,
//                 sku: itemData.sku,
//               },
//             });
//           }
//         } catch (error) {
//           console.error(`Error seeding new order ${entity_id}:`, error);
//           continue;
//         }
//       } else {
//         try {
//           await prisma.order.update({
//             where: { entity_id },
//             data: { ...orderDataWithCustomAttributes },
//           });

//           console.log(`Order ${entity_id} exists. Updating and refreshing products...`);

//           // Delete all existing orderProducts for this order
//           await prisma.orderProduct.deleteMany({
//             where: { order_id: entity_id },
//           });

//           // Recreate all orderProducts
//           for (const itemData of items) {
//             await prisma.orderProduct.create({
//               data: {
//                 ...itemData,
//                 order_id: entity_id,
//                 sku: itemData.sku,
//               },
//             });
//           }
//         } catch (error) {
//           console.error(`Error updating order ${entity_id}:`, error);
//           continue;
//         }
//       }
//     }

//     console.log("Orders seeded successfully");
//     console.log(`Total orders processed: ${orderCount}`);
//   } catch (error) {
//     console.error("Error during seeding:", error);
//   }
// };

// module.exports = seedOrders;

// seedOrders();


// // const { PrismaClient } = require("@prisma/client");
// // const magentoRecentOrders = require("../api-calls/magento-recentOrders.js");

// // const prisma = new PrismaClient();

// // // Seed orders
// // const seedOrders = async () => {
// //   try {
// //     // Fetch orders from API
// //     const response = await magentoRecentOrders(300);

// //     const orders = response.data.items;
// //     let orderCount = 0;

// //     // Seed orders
// //     for (const orderData of orders) {
// //       orderCount++;
// //       const { entity_id, items, extension_attributes, ...order } = orderData;

// //       // Extract custom_po_number, weltpixel_fraud_score, region, city, and method_title from extension_attributes
// //       let custom_po_number = null;
// //       let weltpixel_fraud_score = null;
// //       let region = null;
// //       let city = null;
// //       let method_title = null;
      
// //       if (extension_attributes) {
// //         if (extension_attributes.amasty_order_attributes) {
// //           const poNumberAttribute = extension_attributes.amasty_order_attributes.find(
// //             attr => attr.attribute_code === "custom_po_number"
// //           );
// //           if (poNumberAttribute) {
// //             custom_po_number = poNumberAttribute.value;
// //           }
// //         }
// //         if (extension_attributes.weltpixel_fraud_score !== undefined) {
// //           weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
// //         }
// //         if (extension_attributes.shipping_assignments && extension_attributes.shipping_assignments.length > 0) {
// //           const shippingAssignment = extension_attributes.shipping_assignments[0];
// //           if (shippingAssignment.shipping && shippingAssignment.shipping.address) {
// //             const shippingAddress = shippingAssignment.shipping.address;
// //             region = shippingAddress.region;
// //             city = shippingAddress.city;
// //           }
// //         }
// //         if (extension_attributes.payment_additional_info) {
// //           const methodTitleAttribute = extension_attributes.payment_additional_info.find(
// //             attr => attr.key === "method_title"
// //           );
// //           if (methodTitleAttribute) {
// //             method_title = methodTitleAttribute.value;
// //           }
// //         }
// //       }

// //       // Include custom_po_number, weltpixel_fraud_score, region, city, and method_title in order data
// //       const orderDataWithCustomAttributes = {
// //         ...order,
// //         custom_po_number,
// //         weltpixel_fraud_score,
// //         region,
// //         city,
// //         method_title,
// //       };

// //       const existingOrder = await prisma.order.findUnique({
// //         where: { entity_id },
// //       });

// //       if (!existingOrder) {
// //         try {
// //           // Use try-catch block to catch errors while seeding each order
// //           const createdOrder = await prisma.order.create({
// //             data: { ...orderDataWithCustomAttributes, entity_id },
// //           });

// //           // Seed order products
// //           for (const itemData of items) {
// //             await prisma.orderProduct.create({
// //               data: {
// //                 ...itemData,
// //                 order_id: createdOrder.entity_id, // Use entity_id as order_id
// //                 sku: itemData.sku,
// //               },
// //             });
// //           }
// //         } catch (error) {
// //           console.error(
// //             `Error seeding order with entity_id ${entity_id}:`,
// //             error
// //           );
// //           // Continue to next order even if error occurs
// //           continue;
// //         }
// //       } else {
// //         try {
// //           // If order already exists, update its properties
// //           const updatedOrder = await prisma.order.update({
// //             where: { entity_id },
// //             data: { ...orderDataWithCustomAttributes },
// //           });
// //           console.log(`Order with entity_id ${entity_id} already exists. Updating...`);
// //         } catch (error) {
// //           console.error(
// //             `Error updating order with entity_id ${entity_id}:`,
// //             error
// //           );
// //           // Continue to next order even if error occurs
// //           continue;
// //         }
// //       }
// //     }

// //     console.log("Orders seeded successfully");
// //     console.log(`Total orders seeded: ${orderCount}`);
// //   } catch (error) {
// //     console.error("Error seeding data:", error);
// //   }
// // };

// // module.exports = seedOrders;

// // seedOrders();
