const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const axios = require('axios');

const MAGENTO_BASE_URL = (process.env.MAGENTO_BASE_URL || 'https://www.justjeeps.com').replace(/\/$/, '');
const MAGENTO_KEY = process.env.MAGENTO_KEY;
const PAGE_SIZE = Number(process.env.CANCEL_TEST_ORDER_PAGE_SIZE || 800);
const SMALL_DUE_THRESHOLD = Number(process.env.CANCEL_TEST_ORDER_SMALL_DUE_THRESHOLD || 35);
const MIN_GIFTCARD_COVERAGE = Number(process.env.CANCEL_TEST_ORDER_MIN_GIFTCARD_COVERAGE || 0.9);

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function extractPaymentInfoText(order) {
  const paymentInfo = order?.extension_attributes?.payment_additional_info;
  if (!Array.isArray(paymentInfo)) {
    return '';
  }

  return paymentInfo
    .map((entry) => {
      const key = entry?.key == null ? '' : String(entry.key);
      const value = entry?.value == null ? '' : String(entry.value);
      return `${key}:${value}`;
    })
    .join(' | ')
    .toLowerCase();
}

function hasTransferPayment(order) {
  const methodTitle = normalizeString(order?.method_title);
  const paymentText = extractPaymentInfoText(order);
  return (
    methodTitle.includes('transfer') ||
    methodTitle.includes('e-transfer') ||
    paymentText.includes('transfer') ||
    paymentText.includes('e-transfer') ||
    paymentText.includes('email transfer')
  );
}

function hasCreditCardPayment(order) {
  const methodTitle = normalizeString(order?.method_title);
  const paymentText = extractPaymentInfoText(order);
  return (
    methodTitle.includes('credit') ||
    methodTitle.includes('card') ||
    paymentText.includes('credit') ||
    paymentText.includes('card')
  );
}

function isNotCanceled(order) {
  const status = normalizeString(order?.status);
  return !status.includes('cancel');
}

async function fetchRecentOrders() {
  const endpoint = `${MAGENTO_BASE_URL}/rest/V1/orders`;
  const fields = [
    'items[',
    'entity_id,increment_id,created_at,status,grand_total,base_total_due,method_title,',
    'extension_attributes[payment_additional_info,mageworx_giftcards_amount,base_mageworx_giftcards_amount]',
    ']'
  ].join('');

  const params = {
    'searchCriteria[sortOrders][0][field]': 'created_at',
    'searchCriteria[sortOrders][0][direction]': 'DESC',
    'searchCriteria[pageSize]': PAGE_SIZE,
    fields,
  };

  const response = await axios.get(endpoint, {
    headers: {
      Authorization: `Bearer ${MAGENTO_KEY}`,
      'Content-Type': 'application/json',
    },
    params,
  });

  return Array.isArray(response?.data?.items) ? response.data.items : [];
}

function summarizeOrder(order) {
  const grandTotal = safeNumber(order?.grand_total);
  const due = safeNumber(order?.base_total_due);
  const giftCardAmount = Math.abs(
    safeNumber(order?.extension_attributes?.mageworx_giftcards_amount) ||
      safeNumber(order?.extension_attributes?.base_mageworx_giftcards_amount)
  );
  const coverage = grandTotal > 0 ? giftCardAmount / grandTotal : 0;

  return {
    entity_id: order?.entity_id,
    increment_id: order?.increment_id,
    created_at: order?.created_at,
    status: order?.status,
    method_title: order?.method_title || null,
    grand_total: Number(grandTotal.toFixed(2)),
    base_total_due: Number(due.toFixed(2)),
    gift_card_amount: Number(giftCardAmount.toFixed(2)),
    gift_card_coverage: Number((coverage * 100).toFixed(2)),
  };
}

async function run() {
  if (!MAGENTO_KEY) {
    throw new Error('MAGENTO_KEY is required in .env');
  }

  const orders = await fetchRecentOrders();

  const transferCandidates = orders
    .filter((order) => isNotCanceled(order) && hasTransferPayment(order))
    .slice(0, 10)
    .map(summarizeOrder);

  const ccGiftCardCandidates = orders
    .filter((order) => {
      if (!isNotCanceled(order) || !hasCreditCardPayment(order)) {
        return false;
      }

      const grandTotal = safeNumber(order?.grand_total);
      const due = safeNumber(order?.base_total_due);
      const giftCardAmount = Math.abs(
        safeNumber(order?.extension_attributes?.mageworx_giftcards_amount) ||
          safeNumber(order?.extension_attributes?.base_mageworx_giftcards_amount)
      );

      if (grandTotal <= 0) {
        return false;
      }

      const coverage = giftCardAmount / grandTotal;
      return coverage >= MIN_GIFTCARD_COVERAGE && due <= SMALL_DUE_THRESHOLD;
    })
    .slice(0, 10)
    .map(summarizeOrder);

  const ccGiftCardNearMatches = ccGiftCardCandidates.length
    ? []
    : orders
        .filter((order) => {
          if (!isNotCanceled(order)) {
            return false;
          }

          const due = safeNumber(order?.base_total_due);
          const giftCardAmount = Math.abs(
            safeNumber(order?.extension_attributes?.mageworx_giftcards_amount) ||
              safeNumber(order?.extension_attributes?.base_mageworx_giftcards_amount)
          );

          return giftCardAmount > 0 && due <= SMALL_DUE_THRESHOLD;
        })
        .map((order) => {
          const summary = summarizeOrder(order);
          return {
            ...summary,
            _coverageSort: summary.gift_card_coverage,
          };
        })
        .sort((a, b) => b._coverageSort - a._coverageSort)
        .slice(0, 10)
        .map(({ _coverageSort, ...summary }) => summary);

  console.log('\nTransfer payment candidates (fresh, non-canceled):');
  console.log(JSON.stringify(transferCandidates, null, 2));

  console.log('\nCredit-card + high gift-card coverage candidates (fresh, non-canceled):');
  console.log(JSON.stringify(ccGiftCardCandidates, null, 2));

  if (ccGiftCardCandidates.length === 0) {
    console.log('\nNo strict credit-card + high gift-card matches found in recent orders. Near matches (gift card > 0 and small due):');
    console.log(JSON.stringify(ccGiftCardNearMatches, null, 2));
  }

  console.log('\nSuggested cancel workflow sequence per selected order_id:');
  console.log('1) POST /rest/V1/jwa-order-cancel/orders/{order_id}/void-delete-invoice');
  console.log('2) POST /rest/V1/orders/{order_id}/cancel');
  console.log('3) POST /rest/V1/jwa-order-cancel/orders/{order_id}/ticket');
}

run().catch((error) => {
  const status = error?.response?.status || 'n/a';
  const message = error?.response?.data?.message || error?.response?.data || error.message;
  console.error('FIND_CANCEL_TEST_ORDERS_ERROR', status, message);
  process.exit(1);
});
