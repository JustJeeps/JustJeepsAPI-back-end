require('dotenv').config();
const axios = require('axios');

const API = 'https://www.justjeeps.com/rest/V1';
const headers = {
  Authorization: `Bearer ${process.env.MAGENTO_KEY}`,
  'Content-Type': 'application/json',
};

async function run() {
  const orderId = Number(process.argv[2] || 102077);

  const order = (await axios.get(`${API}/orders/${orderId}`, { headers })).data;
  console.log('ORDER');
  const amastyAttributes = order?.extension_attributes?.amasty_order_attributes || [];
  console.log(
    JSON.stringify(
      {
        entity_id: order?.entity_id,
        increment_id: order?.increment_id,
        subtotal: order?.subtotal,
        shipping_amount: order?.shipping_amount,
        freight_shipping: order?.freight_shipping,
        tax_amount: order?.tax_amount,
        extension_attribute_keys: order?.extension_attributes
          ? Object.keys(order.extension_attributes)
          : [],
        amasty_order_attributes: amastyAttributes,
      },
      null,
      2
    )
  );

  const invoiceResponse = await axios.get(
    `${API}/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`,
    { headers }
  );

  const firstInvoice = (invoiceResponse.data?.items || [])[0] || {};
  console.log('INVOICE');
  console.log(
    JSON.stringify(
      {
        total_count: invoiceResponse.data?.total_count,
        invoice_id: firstInvoice?.entity_id,
        order_id: firstInvoice?.order_id,
        subtotal: firstInvoice?.subtotal,
        shipping_amount: firstInvoice?.shipping_amount,
        grand_total: firstInvoice?.grand_total,
        freight_shipping: firstInvoice?.freight_shipping,
        extension_attribute_keys: firstInvoice?.extension_attributes
          ? Object.keys(firstInvoice.extension_attributes)
          : [],
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
