const axios = require("axios");
const prisma = require("../../../lib/prisma");
const magentoRecentOrders = require("../api-calls/magento-recentOrders.js");

const MAGENTO_API_BASE = process.env.MAGENTO_API_BASE || "https://www.justjeeps.com/rest/V1";
const SEED_ORDER_CONCURRENCY = Number(process.env.SEED_ORDER_CONCURRENCY) || 15;
const ORDER_PRODUCT_CHUNK_SIZE = 500;

const isNumericString = (value) => typeof value === "string" && /^[0-9]+$/.test(value);

const fetchSalesRepLabel = async (entityId) => {
  const token = `Bearer ${process.env.MAGENTO_KEY}`;
  const url = `${MAGENTO_API_BASE}/orders/${entityId}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  });
  const attrs = response?.data?.extension_attributes?.amasty_order_attributes;
  if (!Array.isArray(attrs)) return null;
  const attr = attrs.find((item) => item.attribute_code === "sales_rep");
  return attr?.label ?? null;
};

const chunkArray = (items, size) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const normalizeOrderItemsForCompare = (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => ({
      name: item?.name ?? null,
      sku: item?.sku ?? null,
      order_id: item?.order_id ?? null,
      base_price: Number(item?.base_price ?? 0),
      base_price_incl_tax: Number(item?.base_price_incl_tax ?? 0),
      discount_amount: Number(item?.discount_amount ?? 0),
      discount_invoiced: Number(item?.discount_invoiced ?? 0),
      discount_percent: Number(item?.discount_percent ?? 0),
      original_price: Number(item?.original_price ?? 0),
      price: Number(item?.price ?? 0),
      price_incl_tax: Number(item?.price_incl_tax ?? 0),
      product_id: Number(item?.product_id ?? 0),
      qty_ordered: Number(item?.qty_ordered ?? 0),
    }))
    .sort((a, b) => {
      const skuCompare = String(a.sku).localeCompare(String(b.sku));
      if (skuCompare !== 0) return skuCompare;
      const productCompare = (a.product_id || 0) - (b.product_id || 0);
      if (productCompare !== 0) return productCompare;
      return (a.qty_ordered || 0) - (b.qty_ordered || 0);
    });
};

const getOrderProductSignature = (items) =>
  JSON.stringify(normalizeOrderItemsForCompare(items));

const refreshOrderProducts = async (entityId, items) => {
  await prisma.orderProduct.deleteMany({ where: { order_id: entityId } });
  if (!Array.isArray(items) || items.length === 0) return;

  const data = items.map((itemData) => ({
    ...itemData,
    order_id: entityId,
    sku: itemData.sku,
  }));

  for (const chunk of chunkArray(data, ORDER_PRODUCT_CHUNK_SIZE)) {
    await prisma.orderProduct.createMany({ data: chunk });
  }
};

const processOrder = async (orderData) => {
  const {
    entity_id,
    items,
    extension_attributes,
    freight_shipping: magentoFreightShipping,
    subtotal: magentoSubtotal,
    base_subtotal: magentoBaseSubtotal,
    tax_amount: magentoTaxAmount,
    discount_amount: magentoDiscountAmount,
    ...order
  } = orderData;

  const subtotalFromMagento = parseFloat(magentoSubtotal);
  const baseSubtotalFromMagento = parseFloat(magentoBaseSubtotal);
  const grandTotalFromMagento = parseFloat(order?.grand_total);
  const taxAmountFromMagento = parseFloat(magentoTaxAmount);
  const freightShippingFromMagento = parseFloat(magentoFreightShipping);
  const discountAmountFromMagento = parseFloat(magentoDiscountAmount);
  const giftCardAmountFromMagento = parseFloat(
    extension_attributes?.mageworx_giftcards_amount
  );
  const freight_shipping = Number.isFinite(freightShippingFromMagento)
    ? freightShippingFromMagento
    : null;
  const tax_amount = Number.isFinite(taxAmountFromMagento)
    ? taxAmountFromMagento
    : null;

  let subtotal = null;
  if (Number.isFinite(subtotalFromMagento)) {
    subtotal = subtotalFromMagento;
  } else if (Number.isFinite(baseSubtotalFromMagento)) {
    subtotal = baseSubtotalFromMagento;
  } else if (Number.isFinite(grandTotalFromMagento)) {
    subtotal =
      grandTotalFromMagento -
      (Number.isFinite(taxAmountFromMagento) ? taxAmountFromMagento : 0);
  }

  const shippingAmountFromMagento = parseFloat(order?.shipping_amount);
  const normalizedShipping = Number.isFinite(shippingAmountFromMagento)
    ? shippingAmountFromMagento
    : 0;
  const normalizedSubtotal = Number.isFinite(subtotal) ? subtotal : 0;
  const normalizedTax = Number.isFinite(taxAmountFromMagento)
    ? taxAmountFromMagento
    : 0;
  const normalizedDiscount = Number.isFinite(discountAmountFromMagento)
    ? Math.abs(discountAmountFromMagento)
    : 0;
  const normalizedGiftCard = Number.isFinite(giftCardAmountFromMagento)
    ? Math.abs(giftCardAmountFromMagento)
    : 0;

  let order_bis = null;
  if (Number.isFinite(grandTotalFromMagento)) {
    const bisRaw =
      grandTotalFromMagento -
      normalizedSubtotal -
      normalizedShipping -
      normalizedTax +
      normalizedDiscount +
      normalizedGiftCard;
    order_bis = Number(bisRaw.toFixed(2));
  }

  // Extract custom attributes
  let custom_po_number = null;
  let sales_rep = null;
  let weltpixel_fraud_score = null;
  let region = null;
  let city = null;
  let method_title = null;
  let custom_ship_status = null;
  let custom_order_note = null;
  let shipping_cost_jj = null;

  // new shipping fields
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
      const getAmastyAttr = (code, useLabel = false) => {
        const attr = extension_attributes.amasty_order_attributes.find(
          (attr) => attr.attribute_code === code
        );
        if (!attr) return null;
        return useLabel ? attr.label ?? null : attr.value ?? null;
      };
      custom_po_number = getAmastyAttr("custom_po_number");
      sales_rep = getAmastyAttr("sales_rep", true);
      const shipStatusLabel = getAmastyAttr("custom_ship_status", true);
      custom_ship_status =
        shipStatusLabel || getAmastyAttr("custom_ship_status");
      custom_order_note = getAmastyAttr("custom_order_note");
      shipping_cost_jj = getAmastyAttr("shipping_cost");
    }

    if (!sales_rep || isNumericString(String(sales_rep))) {
      try {
        const fallbackLabel = await fetchSalesRepLabel(entity_id);
        if (fallbackLabel) {
          sales_rep = fallbackLabel;
        }
      } catch (error) {
        console.error(
          `Failed to fetch sales_rep label for entity_id=${entity_id}:`,
          error.response?.status,
          error.response?.data || error.message
        );
      }
    }
    // Set default values if missing
    if (!custom_ship_status) {
      custom_ship_status = "";
    }
    if (!custom_order_note) {
      custom_order_note = "";
    }
    if (extension_attributes.weltpixel_fraud_score !== undefined) {
      weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
    }
    if (
      extension_attributes.shipping_assignments &&
      extension_attributes.shipping_assignments.length > 0
    ) {
      const shippingAssignment = extension_attributes.shipping_assignments[0];
      if (shippingAssignment.shipping && shippingAssignment.shipping.address) {
        const shippingAddress = shippingAssignment.shipping.address;
        region = shippingAddress.region;
        city = shippingAddress.city;

        // map to correct fields
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
    freight_shipping,
    subtotal,
    tax_amount,
    order_bis,
    custom_po_number,
    sales_rep,
    weltpixel_fraud_score,
    region,
    city,
    method_title,
    custom_ship_status,
    custom_order_note,
    shipping_cost_jj,
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
    shipping_company,
  };

  await prisma.order.upsert({
    where: { entity_id },
    create: { ...orderDataWithCustomAttributes, entity_id },
    update: orderDataWithCustomAttributes,
  });

  const existingItems = await prisma.orderProduct.findMany({
    where: { order_id: entity_id },
    select: {
      name: true,
      sku: true,
      order_id: true,
      base_price: true,
      base_price_incl_tax: true,
      discount_amount: true,
      discount_invoiced: true,
      discount_percent: true,
      original_price: true,
      price: true,
      price_incl_tax: true,
      product_id: true,
      qty_ordered: true,
    },
  });

  const nextSignature = getOrderProductSignature(items);
  const existingSignature = getOrderProductSignature(existingItems);

  if (nextSignature !== existingSignature) {
    await refreshOrderProducts(entity_id, items);
  }
};

// Seed orders
const seedOrders = async (
  limit = Number(process.env.SEED_ORDER_LIMIT) || 200,
  options = {}
) => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const startedAt = Date.now();
  console.log(`[seed-orders] Start: limit=${limit}`);
  // const deleteOrders = async () => {
  //   try {
  //     await prisma.order.deleteMany();
  //     console.log("Orders deleted successfully.");
  //   } catch (error) {
  //     console.error("Error deleting orders:", error);
  //   } finally {
  //     await prisma.$disconnect();
  //   }
  // };

  // deleteOrders();

  try {
    // Fetch orders from API
    const response = await magentoRecentOrders(limit);
    const orders = response.data.items || [];
    const totalOrders = orders.length;
    let orderCount = 0;

    if (onProgress) {
      onProgress({ total: totalOrders, processed: 0, status: "running" });
    }

    for (let i = 0; i < orders.length; i += SEED_ORDER_CONCURRENCY) {
      const batch = orders.slice(i, i + SEED_ORDER_CONCURRENCY);
      await Promise.all(
        batch.map(async (orderData) => {
          try {
            await processOrder(orderData);
            orderCount += 1;
          } catch (error) {
            console.error(
              `Error processing order ${orderData?.entity_id}:`,
              error
            );
          }
        })
      );

      if (onProgress) {
        onProgress({ total: totalOrders, processed: orderCount, status: "running" });
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log("Orders seeded successfully");
    console.log(`Total orders processed: ${orderCount}`);
    console.log(`[seed-orders] Done in ${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`);

    if (onProgress) {
      onProgress({ total: totalOrders, processed: orderCount, status: "done" });
    }
  } catch (error) {
    console.error("Error during seeding:", error);
    const durationMs = Date.now() - startedAt;
    console.log(`[seed-orders] Failed after ${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`);

    if (onProgress) {
      onProgress({ total: 0, processed: 0, status: "error", error: error?.message || "Seed failed" });
    }
  }
};

module.exports = seedOrders;

// Executa apenas quando rodado diretamente (npm run seed-orders)
// Não executa quando importado por outro arquivo (server.js)
if (require.main === module) {
  seedOrders();
}


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
