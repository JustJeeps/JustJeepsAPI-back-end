/*
 * seed-orders-all.js — Paginated + resilient seeding from Magento
 * - Avoids massive single-request payloads by using currentPage pagination
 * - Adds defensive fetch with retries/backoff on 5xx
 * - Deletes existing order/orderProduct rows before reseeding (no early disconnect)
 * - Extracts the same custom attributes you were using (shipping fields, PO#, fraud score, etc.)
 */

const axios = require("axios");

const prisma = require("../../../lib/prisma");

// ======== Config ========
const PAGE_SIZE = parseInt(process.env.SEED_PAGE_SIZE || "400", 10); // tune 200–500
const MAX_PAGES = parseInt(process.env.SEED_MAX_PAGES || "15", 10); // safety cap
const MAX_RETRIES = 3;
const BASE_URL_PREFIX =
  "https://www.justjeeps.com/rest/V1/orders/?searchCriteria[sortOrders][0][field]=created_at";
const FIELDS =
  "items[created_at,status,customer_email,customer_firstname,customer_lastname,entity_id,grand_total,increment_id,order_currency_code,total_qty_ordered,base_total_due,coupon_code,shipping_description,shipping_amount,items[base_total_due,name,sku,order_id,base_price,base_price_incl_tax,discount_amount,discount_invoiced,discount_percent,original_price,price,price_incl_tax,product_id,qty_ordered],extension_attributes[amasty_order_attributes,weltpixel_fraud_score,shipping_assignments,payment_additional_info]]";

function authHeaders() {
  const token = `Bearer ${process.env.MAGENTO_KEY}`;
  return {
    Authorization: token,
    "Content-Type": "application/json",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOrdersPage(pageSize, currentPage) {
  const url =
    `${BASE_URL_PREFIX}` +
    `&searchCriteria[pageSize]=${pageSize}` +
    `&searchCriteria[currentPage]=${currentPage}` +
    `&fields=${encodeURIComponent(FIELDS)}`;

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const resp = await axios.get(url, { headers: authHeaders() });
      const items = resp?.data?.items || [];
      return items;
    } catch (err) {
      attempt++;
      const status = err?.response?.status;
      const retriable = !status || (status >= 500 && status < 600) || status === 429;
      if (attempt > MAX_RETRIES || !retriable) {
        console.error(
          `❌ Failed fetching page ${currentPage} (status=${status || "n/a"}):`,
          err?.message
        );
        throw err;
      }
      const wait = 500 * attempt; // simple backoff
      console.warn(
        `⚠️  Retrying page ${currentPage} in ${wait}ms… (attempt ${attempt}/${MAX_RETRIES}) status=${status}`
      );
      await sleep(wait);
    }
  }
}

function extractOrderAttributes(orderData) {
  const { entity_id, items: orderItems = [], extension_attributes, ...order } = orderData;

  let custom_po_number = null;
  let weltpixel_fraud_score = null;
  let region = null;
  let city = null;
  let method_title = null;

  // Shipping fields
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
    if (Array.isArray(extension_attributes.amasty_order_attributes)) {
      const poAttr = extension_attributes.amasty_order_attributes.find(
        (a) => a.attribute_code === "custom_po_number"
      );
      if (poAttr) custom_po_number = poAttr.value ?? null;
    }

    if (extension_attributes.weltpixel_fraud_score !== undefined) {
      weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
    }

    if (
      extension_attributes.shipping_assignments &&
      extension_attributes.shipping_assignments.length > 0
    ) {
      const shippingAssignment = extension_attributes.shipping_assignments[0];
      const shippingAddress = shippingAssignment?.shipping?.address;
      if (shippingAddress) {
        region = shippingAddress.region ?? null;
        city = shippingAddress.city ?? null;

        shipping_firstname = shippingAddress.firstname ?? null;
        shipping_lastname = shippingAddress.lastname ?? null;
        shipping_postcode = shippingAddress.postcode ?? null;
        shipping_street1 = shippingAddress.street?.[0] ?? null;
        shipping_street2 = shippingAddress.street?.[1] ?? null;
        shipping_street3 = shippingAddress.street?.[2] ?? null;
        shipping_telephone = shippingAddress.telephone ?? null;
        shipping_country_id = shippingAddress.country_id ?? null;
        shipping_city = shippingAddress.city ?? null;
        shipping_region = shippingAddress.region ?? null;
        shipping_company = shippingAddress.company ?? null;
      }
    }

    if (Array.isArray(extension_attributes.payment_additional_info)) {
      const methodTitleAttribute = extension_attributes.payment_additional_info.find(
        (attr) => attr.key === "method_title"
      );
      if (methodTitleAttribute) method_title = methodTitleAttribute.value ?? null;
    }
  }

  return {
    entity_id,
    orderItems,
    orderDataWithCustomAttributes: {
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
      shipping_company,
    },
  };
}

function buildBatchRows(parsedOrders) {
  const orderRows = [];
  const orderProductRows = [];

  for (const parsed of parsedOrders) {
    const { entity_id, orderItems, orderDataWithCustomAttributes } = parsed;
    orderRows.push({ ...orderDataWithCustomAttributes, entity_id });

    for (const itemData of orderItems) {
      orderProductRows.push({
        ...itemData,
        order_id: entity_id,
        sku: itemData.sku,
      });
    }
  }

  return { orderRows, orderProductRows };
}

async function seedOrders() {
  const startTimeMs = Date.now();
  let totalProcessed = 0;
  try {
    // Clean slate (delete children first if no cascade)
    await prisma.orderProduct.deleteMany();
    await prisma.order.deleteMany();
    console.log("🗑️  Existing orders cleared.");

    let currentPage = 1;
    for (; currentPage <= MAX_PAGES; currentPage++) {
      const items = await fetchOrdersPage(PAGE_SIZE, currentPage);
      if (!items.length) {
        console.log(`No items returned on page ${currentPage}. Stopping.`);
        break;
      }

      const parsedOrders = [];
      for (const orderData of items) {
        try {
          parsedOrders.push(extractOrderAttributes(orderData));
        } catch (err) {
          console.error(
            `Error processing order entity_id=${orderData?.entity_id} on page ${currentPage}:`,
            err?.message
          );
        }
      }

      const { orderRows, orderProductRows } = buildBatchRows(parsedOrders);
      if (orderRows.length) {
        const skuSet = new Set(orderProductRows.map((row) => row.sku).filter(Boolean));
        let filteredOrderProductRows = orderProductRows;
        if (skuSet.size > 0) {
          const existingProducts = await prisma.product.findMany({
            where: { sku: { in: Array.from(skuSet) } },
            select: { sku: true },
          });
          const existingSkuSet = new Set(existingProducts.map((p) => p.sku));
          filteredOrderProductRows = orderProductRows.filter((row) => existingSkuSet.has(row.sku));
        }

        await prisma.$transaction([
          prisma.order.createMany({ data: orderRows, skipDuplicates: true }),
          prisma.orderProduct.createMany({ data: filteredOrderProductRows, skipDuplicates: true }),
        ]);
        totalProcessed += orderRows.length;
      }

      console.log(`✅ Page ${currentPage} processed (${items.length} orders). Total so far: ${totalProcessed}`);

      // If we received less than a full page, we're done
      if (items.length < PAGE_SIZE) break;
    }

    const elapsedMs = Date.now() - startTimeMs;
    const elapsedSec = (elapsedMs / 1000).toFixed(2);
    console.log(`🎉 Orders seeded successfully. Total processed: ${totalProcessed}`);
    console.log(`⏱️  Execution time: ${elapsedSec}s`);
  } catch (error) {
    console.error("Error during seeding:", error);
  } finally {
    await prisma.$disconnect();
  }
}

seedOrders();








