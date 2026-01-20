// seed-orders-to-json.js
const axios = require("axios");
const fs = require("fs");

const M2_BASE = process.env.M2_BASE || "https://www.justjeeps.com/rest/default";
const M2_USER = process.env.M2_USER || "Admin-Tess";
const M2_PASS = process.env.M2_PASS || "Santos5337$$";

// 👇 Edit these when running
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || "500", 10); // orders per page
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "100", 10);   // how many pages

async function getToken() {
  const { data } = await axios.post(
    `${M2_BASE}/V1/integration/admin/token`,
    { username: M2_USER, password: M2_PASS },
    { headers: { "Content-Type": "application/json" } }
  );
  return data;
}

async function fetchOrders(token, page = 1, pageSize = PAGE_SIZE) {
  const url = `${M2_BASE}/V1/orders/?searchCriteria[sortOrders][0][field]=created_at&searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${page}&fields=total_count,items[created_at,status,customer_email,entity_id,grand_total,increment_id,order_currency_code,total_qty_ordered,items[base_total_due,name,sku,order_id,base_price,price,product_id,qty_ordered]]`;



  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function main() {
  try {
    const token = await getToken();
    console.log("✅ Got Magento token");

    let allOrders = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      console.log(`⬇️ Fetching page ${page}/${MAX_PAGES} (${PAGE_SIZE} orders per page)...`);
      const data = await fetchOrders(token, page);
      if (!data.items || data.items.length === 0) {
        console.log("⚠️ No more orders found, stopping.");
        break;
      }
      allOrders = allOrders.concat(data.items);

      // save each page separately
      // fs.writeFileSync(`orders_page${page}.json`, JSON.stringify(data, null, 2));
    }

    // save all in one big file too
    fs.writeFileSync("orders_all.json", JSON.stringify(allOrders, null, 2));
    console.log(`✅ Saved ${allOrders.length} orders total`);
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

main();
