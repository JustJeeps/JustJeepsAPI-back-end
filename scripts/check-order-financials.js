const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const axios = require('axios');
const prisma = require('../lib/prisma');

async function run() {
  const incrementId = process.argv[2] || '200065571';

  const dbOrder = await prisma.order.findFirst({
    where: { increment_id: incrementId },
    select: {
      entity_id: true,
      increment_id: true,
      subtotal: true,
      shipping_amount: true,
      tax_amount: true,
      order_bis: true,
      grand_total: true,
      freight_shipping: true,
    },
  });

  const user = await prisma.user.findFirst({ select: { id: true } });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const response = await axios.get('http://localhost:8080/api/orders', {
    params: { page: 1, limit: 200, search: incrementId },
    headers: { Authorization: `Bearer ${token}` },
  });

  const rows = response.data?.data || [];
  const apiOrder = rows.find((item) => String(item.increment_id) === String(incrementId));

  const items = Array.isArray(apiOrder?.items) ? apiOrder.items : [];
  const subtotalFromItems = items.reduce((acc, item) => {
    const basePrice = parseFloat(item?.base_price);
    const qty = parseFloat(item?.qty_ordered);
    if (!Number.isFinite(basePrice) || !Number.isFinite(qty)) return acc;
    return acc + basePrice * qty;
  }, 0);
  const inferredTaxFromItems = items.reduce((acc, item) => {
    const price = parseFloat(item?.price ?? item?.base_price);
    const priceInclTax = parseFloat(item?.price_incl_tax ?? item?.base_price_incl_tax);
    const qty = parseFloat(item?.qty_ordered);
    if (!Number.isFinite(price) || !Number.isFinite(priceInclTax) || !Number.isFinite(qty)) return acc;
    const unitTax = priceInclTax - price;
    return acc + (unitTax > 0 ? unitTax * qty : 0);
  }, 0);
  const inferredBisFromTotals = Number.isFinite(parseFloat(apiOrder?.grand_total))
    ? parseFloat(apiOrder?.grand_total) - subtotalFromItems - parseFloat(apiOrder?.shipping_amount || 0) - inferredTaxFromItems
    : null;

  console.log(
    JSON.stringify(
      {
        incrementId,
        db: dbOrder || null,
        api: apiOrder
          ? {
              increment_id: apiOrder.increment_id,
              subtotal: apiOrder.subtotal,
              shipping_amount: apiOrder.shipping_amount,
              tax_amount: apiOrder.tax_amount,
              order_bis: apiOrder.order_bis,
              grand_total: apiOrder.grand_total,
              freight_shipping: apiOrder.freight_shipping,
              item_count: Array.isArray(apiOrder.items) ? apiOrder.items.length : 0,
              inferred_subtotal_from_items: Number(subtotalFromItems.toFixed(2)),
              inferred_tax_from_items: Number(inferredTaxFromItems.toFixed(2)),
              inferred_bis_from_totals:
                inferredBisFromTotals === null ? null : Number(inferredBisFromTotals.toFixed(2)),
              first_item_sample:
                Array.isArray(apiOrder.items) && apiOrder.items.length > 0
                  ? {
                      tax_amount: apiOrder.items[0].tax_amount,
                      base_tax_amount: apiOrder.items[0].base_tax_amount,
                      price: apiOrder.items[0].price,
                      price_incl_tax: apiOrder.items[0].price_incl_tax,
                      base_price: apiOrder.items[0].base_price,
                      base_price_incl_tax: apiOrder.items[0].base_price_incl_tax,
                      qty_ordered: apiOrder.items[0].qty_ordered,
                    }
                  : null,
            }
          : null,
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error('CHECK_ORDER_FINANCIALS_ERROR', error.response?.status, error.response?.data || error.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch (_) {}
  });
