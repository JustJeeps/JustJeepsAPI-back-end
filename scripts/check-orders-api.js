const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const axios = require('axios');
const prisma = require('../lib/prisma');

async function run() {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    console.log('NO_USER');
    return;
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const response = await axios.get('http://localhost:8080/api/orders', {
    params: { page: 1, limit: 200, search: '200065551' },
    headers: { Authorization: `Bearer ${token}` },
  });

  const rows = response.data?.data || [];
  const row = rows.find((item) => String(item.increment_id) === '200065551');

  console.log(
    JSON.stringify(
      {
        found: !!row,
        increment_id: row?.increment_id,
        subtotal: row?.subtotal,
        shipping_amount: row?.shipping_amount,
        tax_amount: row?.tax_amount,
        order_bis: row?.order_bis,
        grand_total: row?.grand_total,
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error('API_CHECK_ERROR', error.response?.status, error.response?.data || error.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch (_) {}
  });
