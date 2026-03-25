const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const axios = require('axios');

const API = 'https://www.justjeeps.com/rest/V1';
const headers = {
  Authorization: `Bearer ${process.env.MAGENTO_KEY}`,
  'Content-Type': 'application/json',
};

async function run() {
  const incrementId = process.argv[2];
  if (!incrementId) {
    console.error('Usage: node scripts/magento-order-totals-probe.js <increment_id>');
    process.exit(1);
  }

  const url = `${API}/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${incrementId}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;
  const response = await axios.get(url, { headers });
  const order = (response.data?.items || [])[0];

  if (!order) {
    console.log('NOT_FOUND');
    return;
  }

  const subtotal = Number(order.subtotal || 0);
  const shippingAmount = Number(order.shipping_amount || 0);
  const taxAmount = Number(order.tax_amount || 0);
  const discountAmountAbs = Math.abs(Number(order.discount_amount || 0));
  const grandTotal = Number(order.grand_total || 0);

  const bisEstimate = grandTotal - subtotal - shippingAmount - taxAmount + discountAmountAbs;

  console.log(
    JSON.stringify(
      {
        entity_id: order.entity_id,
        increment_id: order.increment_id,
        subtotal: order.subtotal,
        shipping_amount: order.shipping_amount,
        tax_amount: order.tax_amount,
        discount_amount: order.discount_amount,
        grand_total: order.grand_total,
        bis_estimate: Number.isFinite(bisEstimate) ? Number(bisEstimate.toFixed(2)) : null,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error('PROBE_ERROR', error.response?.status, error.response?.data || error.message);
  process.exit(1);
});
