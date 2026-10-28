/*
 * seed-orders-all.js — Paginated + resilient seeding from Magento
 * - Avoids massive single-request payloads by using currentPage pagination
 * - Adds defensive fetch with retries/backoff on 5xx
 * - Fetches everything first, then swaps the tables in ONE short transaction:
 *   readers never see an empty/partial orders table mid-reseed
 * - Aborts before any write if Magento returns suspiciously few orders
 * - Extracts the same custom attributes you were using (shipping fields, PO#, fraud score, etc.)
 */

const axios = require("axios");

const prisma = require("../../../lib/prisma");
const { acquireOrderSyncLock, releaseOrderSyncLock, orderSyncLockLost } = require("../../../lib/orderSyncLock.js");
const { saveWatermark } = require("../../../lib/ordersWatermark.js");

// ======== Config ========
const PAGE_SIZE = parseInt(process.env.SEED_PAGE_SIZE || "400", 10); // tune 200–500
const MAX_PAGES = parseInt(process.env.SEED_MAX_PAGES || "15", 10); // safety cap
const MAX_RETRIES = 3;
// Piso de sanidade: menos que isso indica Magento quebrado/token invalido —
// abortar em vez de trocar a tabela por um resultado vazio.
const MIN_ORDERS_FOR_SWAP = parseInt(process.env.SEED_ALL_MIN_ORDERS || "50", 10);
const SWAP_TIMEOUT_MS = parseInt(process.env.SEED_ALL_SWAP_TIMEOUT_MS || "120000", 10);
// Paginas buscadas em paralelo por janela. 15 paginas / 3 = ~35 req/min no
// pico — dentro do mandato de <=60 req/min do hosting do Magento.
const FETCH_CONCURRENCY = parseInt(process.env.SEED_ALL_FETCH_CONCURRENCY || "3", 10);
const INSERT_CHUNK_SIZE = 500;

const chunkRows = (rows, size) => {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
};

// Magento usa "YYYY-MM-DD HH:MM:SS" em UTC — comparacao lexicografica desse
// formato equivale a comparacao cronologica (mesma convencao do delta).
const toMagentoUtc = (date) => date.toISOString().slice(0, 19).replace("T", " ");
const BASE_URL_PREFIX =
  "https://www.justjeeps.com/rest/V1/orders/?searchCriteria[sortOrders][0][field]=created_at";
const FIELDS =
  "items[created_at,updated_at,status,customer_email,customer_firstname,customer_lastname,billing_address,entity_id,grand_total,subtotal,base_subtotal,tax_amount,discount_amount,increment_id,order_currency_code,total_qty_ordered,base_total_due,coupon_code,shipping_description,shipping_amount,freight_shipping,maxmind_data,items[base_total_due,name,sku,order_id,base_price,base_price_incl_tax,discount_amount,discount_invoiced,discount_percent,original_price,price,price_incl_tax,product_id,qty_ordered],extension_attributes[amasty_order_attributes,weltpixel_fraud_score,maxmind_data,shipping_assignments,payment_additional_info,mageworx_giftcards_amount,base_mageworx_giftcards_amount]]";

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
  const {
    entity_id,
    items,
    extension_attributes,
    freight_shipping: magentoFreightShipping,
    subtotal: magentoSubtotal,
    base_subtotal: magentoBaseSubtotal,
    tax_amount: magentoTaxAmount,
    discount_amount: magentoDiscountAmount,
    maxmind_data: rootMaxmindData,
    billing_address: billingAddress,
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
    subtotal = grandTotalFromMagento - (Number.isFinite(taxAmountFromMagento) ? taxAmountFromMagento : 0);
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

  let custom_po_number = null;
  let sales_rep = null;
  let weltpixel_fraud_score = null;
  let region = null;
  let city = null;
  let method_title = null;
  let custom_ship_status = null;
  let custom_order_note = null;
  let shipping_cost_jj = null;
  let email_first_seen = null;

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
  let billing_city = null;
  let billing_country_id = null;
  let billing_postcode = null;
  let billing_region = null;
  let billing_street = null;

  if (billingAddress) {
    billing_city = billingAddress.city ?? null;
    billing_country_id = billingAddress.country_id ?? null;
    billing_postcode = billingAddress.postcode ?? null;
    billing_region = billingAddress.region ?? null;
    billing_street = Array.isArray(billingAddress.street)
      ? billingAddress.street.filter(Boolean).join("\n")
      : billingAddress.street ?? null;
  }

  if (extension_attributes) {
    if (Array.isArray(extension_attributes.amasty_order_attributes)) {
      const getAmastyAttr = (code, useLabel = false) => {
        const attr = extension_attributes.amasty_order_attributes.find(
          (a) => a.attribute_code === code
        );
        if (!attr) return null;
        return useLabel ? attr.label ?? null : attr.value ?? null;
      };
      custom_po_number = getAmastyAttr("custom_po_number");
      sales_rep = getAmastyAttr("sales_rep", true);
      const shipStatusLabel = getAmastyAttr("custom_ship_status", true);
      custom_ship_status = shipStatusLabel || getAmastyAttr("custom_ship_status");
      custom_order_note = getAmastyAttr("custom_order_note");
      shipping_cost_jj = getAmastyAttr("shipping_cost");
    }

    if (extension_attributes.weltpixel_fraud_score !== undefined) {
      weltpixel_fraud_score = extension_attributes.weltpixel_fraud_score;
    }

    email_first_seen =
      extension_attributes.maxmind_data?.email?.first_seen ??
      extension_attributes.maxmind_data?.email_first_seen ??
      null;

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

  email_first_seen =
    rootMaxmindData?.email?.first_seen ??
    rootMaxmindData?.email_first_seen ??
    email_first_seen;

  const orderItems = Array.isArray(items) ? items : [];

  return {
    entity_id,
    orderItems,
    orderDataWithCustomAttributes: {
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
      email_first_seen,
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
      billing_city,
      billing_country_id,
      billing_postcode,
      billing_region,
      billing_street,
    },
  };
}

const ORDER_FIELDS = new Set([
  "created_at",
  "updated_at",
  "customer_email",
  "coupon_code",
  "customer_firstname",
  "customer_lastname",
  "grand_total",
  "increment_id",
  "order_currency_code",
  "total_qty_ordered",
  "status",
  "base_total_due",
  "shipping_amount",
  "shipping_cost_jj",
  "shipping_description",
  "custom_po_number",
  "weltpixel_fraud_score",
  "email_first_seen",
  "city",
  "region",
  "method_title",
  "shipping_city",
  "shipping_country_id",
  "shipping_firstname",
  "shipping_lastname",
  "shipping_postcode",
  "shipping_region",
  "shipping_street1",
  "shipping_street2",
  "shipping_street3",
  "shipping_telephone",
  "shipping_company",
  "billing_city",
  "billing_country_id",
  "billing_postcode",
  "billing_region",
  "billing_street",
  "sales_rep",
  "subtotal",
  "freight_shipping",
  "order_bis",
  "tax_amount",
  "custom_order_note",
  "custom_ship_status",
]);

function pickOrderFields(input) {
  const output = {};
  Object.keys(input || {}).forEach((key) => {
    if (ORDER_FIELDS.has(key)) {
      output[key] = input[key];
    }
  });
  return output;
}

function buildBatchRows(parsedOrders) {
  const orderRows = [];
  const orderProductRows = [];

  for (const parsed of parsedOrders) {
    const { entity_id, orderItems, orderDataWithCustomAttributes } = parsed;
    orderRows.push({ ...pickOrderFields(orderDataWithCustomAttributes), entity_id });

    const safeOrderItems = Array.isArray(orderItems) ? orderItems : [];
    for (const itemData of safeOrderItems) {
      orderProductRows.push({
        ...itemData,
        order_id: entity_id,
        sku: itemData.sku,
      });
    }
  }

  return { orderRows, orderProductRows };
}

async function seedOrders(options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const startTimeMs = Date.now();
  let totalProcessed = 0;

  // Full reseed faz deleteMany antes de reimportar: nunca pode rodar em
  // paralelo com o delta sync (ou outro full reseed). Lease curta renovada a
  // cada 60s (lib/orderSyncLock.js): se o processo morrer, libera em <=5min.
  const locked = await acquireOrderSyncLock();
  if (!locked) {
    console.log("[seed-orders-all] Skipped: another order sync holds the lock.");
    if (onProgress) {
      onProgress({
        total: null,
        processed: 0,
        status: "error",
        error: "Another order sync is already running",
      });
    }
    return;
  }

  try {
    // Total is unknown up-front: we page until a short/empty page
    if (onProgress) {
      onProgress({ total: null, processed: 0, status: "running" });
    }

    // Momento do inicio do scan: fallback do watermark caso nenhuma row
    // traga updated_at (mesma semantica do delta).
    const scanStartUtc = toMagentoUtc(new Date());

    // ===== Fase 1: buscar TUDO do Magento (fora de transacao) =====
    // A parte lenta acontece sem tocar no banco; a troca em si e uma
    // transacao curta na fase 3, entao leitores nunca veem tabela vazia.
    // Paginas sao buscadas em janelas de FETCH_CONCURRENCY em paralelo:
    // mesmos 15 requests no total, so mais compactos no tempo — bem abaixo
    // do teto de 60 req/min do hosting do Magento.
    // Dedupe por entity_id: se a paginacao deslizar durante o scan, a ultima
    // ocorrencia do pedido vence (Map preserva ordem de insercao por pagina).
    const parsedByEntityId = new Map();

    let reachedEnd = false;
    for (let windowStart = 1; windowStart <= MAX_PAGES && !reachedEnd; windowStart += FETCH_CONCURRENCY) {
      // Perdemos o lock (lease expirou com o processo travado e outro sync
      // assumiu)? Abortar ANTES do deleteMany/import — nunca em paralelo.
      if (orderSyncLockLost()) {
        throw new Error("Order sync lock lost mid-run; aborting to avoid concurrent writes");
      }
      const pageNumbers = [];
      for (let p = windowStart; p < windowStart + FETCH_CONCURRENCY && p <= MAX_PAGES; p++) {
        pageNumbers.push(p);
      }

      const results = await Promise.all(
        pageNumbers.map((page) =>
          fetchOrdersPage(PAGE_SIZE, page).then((items) => ({ page, items }))
        )
      );

      for (const { page, items } of results) {
        if (reachedEnd) break;
        if (!items.length) {
          console.log(`No items returned on page ${page}. Stopping.`);
          reachedEnd = true;
          break;
        }

        for (const orderData of items) {
          try {
            const parsed = extractOrderAttributes(orderData);
            parsedByEntityId.set(parsed.entity_id, parsed);
          } catch (err) {
            console.error(
              `Error processing order entity_id=${orderData?.entity_id} on page ${page}:`,
              err?.message
            );
          }
        }

        console.log(`✅ Page ${page} fetched (${items.length} orders). Total so far: ${parsedByEntityId.size}`);

        // If we received less than a full page, we're done
        if (items.length < PAGE_SIZE) reachedEnd = true;
      }

      totalProcessed = parsedByEntityId.size;
      if (onProgress) {
        onProgress({ total: null, processed: totalProcessed, status: "running" });
      }
    }

    const { orderRows: allOrderRows, orderProductRows: allOrderProductRows } =
      buildBatchRows(Array.from(parsedByEntityId.values()));
    totalProcessed = allOrderRows.length;

    // Resultado suspeito de vazio/pequeno (Magento fora, WAF, token invalido)
    // NUNCA pode apagar a tabela — aborta antes de qualquer write.
    if (allOrderRows.length < MIN_ORDERS_FOR_SWAP) {
      throw new Error(
        `Only ${allOrderRows.length} orders fetched (min ${MIN_ORDERS_FOR_SWAP}); aborting before destructive swap`
      );
    }

    // ===== Fase 2: filtrar orderProducts para SKUs existentes (so leitura) =====
    const skuList = Array.from(
      new Set(allOrderProductRows.map((row) => row.sku).filter(Boolean))
    );
    const existingSkuSet = new Set();
    for (const chunk of chunkRows(skuList, 2000)) {
      const existingProducts = await prisma.product.findMany({
        where: { sku: { in: chunk } },
        select: { sku: true },
      });
      for (const product of existingProducts) existingSkuSet.add(product.sku);
    }
    const filteredOrderProductRows = skuList.length > 0
      ? allOrderProductRows.filter((row) => existingSkuSet.has(row.sku))
      : allOrderProductRows;

    // ===== Fase 3: swap atomico (transacao curta, so writes) =====
    // Ultima checagem de posse antes do trecho destrutivo: se outro sync
    // assumiu o lock durante o fetch longo, abortar aqui evita deleteMany
    // em paralelo com escritas dele.
    if (orderSyncLockLost()) {
      throw new Error("Order sync lock lost before swap; aborting to avoid concurrent writes");
    }
    await prisma.$transaction(
      async (tx) => {
        await tx.orderProduct.deleteMany();
        await tx.order.deleteMany();
        for (const chunk of chunkRows(allOrderRows, INSERT_CHUNK_SIZE)) {
          await tx.order.createMany({ data: chunk, skipDuplicates: true });
        }
        for (const chunk of chunkRows(filteredOrderProductRows, INSERT_CHUNK_SIZE)) {
          await tx.orderProduct.createMany({ data: chunk, skipDuplicates: true });
        }
      },
      { maxWait: 10_000, timeout: SWAP_TIMEOUT_MS }
    );

    // So no caminho de sucesso (apos o swap): avanca o watermark compartilhado
    // para max(updated_at) importado, como o delta faz — o proximo delta nao
    // reprocessa o que este full reseed ja trouxe, e o "Last sync" da tela de
    // Orders (updatedAt desta chave) passa a refletir tambem o full reseed.
    let maxUpdatedAt = null;
    for (const row of allOrderRows) {
      const updatedAt = row?.updated_at;
      if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
        maxUpdatedAt = updatedAt;
      }
    }
    await saveWatermark(prisma, maxUpdatedAt || scanStartUtc);

    const elapsedMs = Date.now() - startTimeMs;
    const elapsedSec = (elapsedMs / 1000).toFixed(2);
    console.log(`🎉 Orders swapped atomically. Total processed: ${totalProcessed} (${filteredOrderProductRows.length} items)`);
    console.log(`⏱️  Execution time: ${elapsedSec}s`);

    if (onProgress) {
      onProgress({ total: totalProcessed, processed: totalProcessed, status: "done" });
    }
  } catch (error) {
    console.error("Error during seeding:", error);
    if (onProgress) {
      onProgress({
        total: null,
        processed: totalProcessed,
        status: "error",
        error: error?.message || "Seed failed",
      });
    }
  } finally {
    await releaseOrderSyncLock();
  }
}

if (require.main === module) {
  // Only the CLI owns the shared prisma client's lifecycle; when required by
  // the server, disconnecting here would kill the server's client mid-flight.
  seedOrders().finally(() => prisma.$disconnect());
}

module.exports = seedOrders;








