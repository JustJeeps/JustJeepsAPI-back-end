const axios = require("axios");

const MAGENTO_API_BASE = process.env.MAGENTO_API_BASE || "https://www.justjeeps.com/rest/V1";
const MAX_RETRIES = Number(process.env.SEED_ORDERS_DELTA_MAX_RETRIES) || 3;

const FIELDS =
  "items[created_at,updated_at,status,customer_email,customer_firstname,customer_lastname,billing_address,entity_id,grand_total,subtotal,base_subtotal,tax_amount,discount_amount,increment_id,order_currency_code,total_qty_ordered,base_total_due,coupon_code,shipping_description,shipping_amount,freight_shipping,maxmind_data,items[base_total_due,name,sku,order_id,base_price,base_price_incl_tax,discount_amount,discount_invoiced,discount_percent,original_price,price,price_incl_tax,product_id,qty_ordered],extension_attributes[amasty_order_attributes,weltpixel_fraud_score,maxmind_data,shipping_assignments,payment_additional_info,mageworx_giftcards_amount,base_mageworx_giftcards_amount]]";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.MAGENTO_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function getOrdersUpdatedSince(sinceUtc, options = {}) {
  const pageSize = Number(options.pageSize) || 100;
  const currentPage = Number(options.currentPage) || 1;
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
    "searchCriteria[filterGroups][0][filters][0][value]": sinceUtc,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[sortOrders][0][field]": "updated_at",
    "searchCriteria[sortOrders][0][direction]": "ASC",
    "searchCriteria[pageSize]": String(pageSize),
    "searchCriteria[currentPage]": String(currentPage),
    fields: FIELDS,
  });

  const url = `${MAGENTO_API_BASE}/orders?${params.toString()}`;

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const response = await axios.get(url, { headers: authHeaders(), timeout: 60000 });
      return response.data;
    } catch (error) {
      attempt += 1;
      const status = error?.response?.status;
      const retriable = !status || status === 429 || (status >= 500 && status < 600);

      if (attempt > MAX_RETRIES || !retriable) {
        console.error(
          `[magento-ordersUpdatedSince] Failed page ${currentPage} updated_at >= ${sinceUtc} (status=${status || "n/a"}):`,
          error?.message
        );
        throw error;
      }

      const waitMs = 500 * attempt;
      console.warn(
        `[magento-ordersUpdatedSince] Retrying page ${currentPage} in ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES}, status=${status || "n/a"})`
      );
      await sleep(waitMs);
    }
  }
}

module.exports = getOrdersUpdatedSince;