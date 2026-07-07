#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../lib/prisma');

const PROMO_START = process.env.PROMO_START || '2026-06-29';
const PROMO_END = process.env.PROMO_END || '2026-07-05';
const PREVIOUS_WEEK_COUNT = Number(process.env.PREVIOUS_WEEK_COUNT || 4);

const BUCKETS = [
  { key: 'under_199', label: 'Under $199', min: 0, max: 199 },
  { key: 'promo_band_199_to_249', label: '$199-$249.99', min: 199, max: 250 },
  { key: 'promo_band_250_to_299', label: '$250-$299.99', min: 250, max: 300 },
  { key: 'promo_band_300_to_349', label: '$300-$349.99', min: 300, max: 350 },
  { key: 'standard_free_shipping_350_plus', label: '$350+', min: 350, max: Infinity },
];

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return round((numerator / denominator) * 100, 1);
}

function getBucket(subtotal) {
  return BUCKETS.find((bucket) => subtotal >= bucket.min && subtotal < bucket.max) || BUCKETS[0];
}

function parseDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function buildWindows() {
  const windows = [];
  for (let weekOffset = PREVIOUS_WEEK_COUNT; weekOffset >= 1; weekOffset--) {
    const startOffset = -7 * weekOffset;
    const endOffset = startOffset + 6;
    windows.push({
      key: `previous_week_${weekOffset}`,
      label: `${weekOffset} week${weekOffset === 1 ? '' : 's'} before promo`,
      start: addDays(PROMO_START, startOffset),
      end: addDays(PROMO_START, endOffset),
    });
  }
  windows.push({ key: 'promo', label: 'Promo: free shipping over $199', start: PROMO_START, end: PROMO_END });
  return windows;
}

function emptyMetric() {
  return {
    orders: 0,
    qty: 0,
    subtotal: 0,
    grandTotal: 0,
    tax: 0,
    shippingCollected: 0,
    bis: 0,
    freeShippingOrders: 0,
    paidShippingOrders: 0,
  };
}

function addOrder(metric, order) {
  const subtotal = Number(order.subtotal || 0);
  const shipping = Number(order.shipping_amount || 0);

  metric.orders += 1;
  metric.qty += Number(order.total_qty_ordered || 0);
  metric.subtotal += subtotal;
  metric.grandTotal += Number(order.grand_total || 0);
  metric.tax += Number(order.tax_amount || 0);
  metric.shippingCollected += shipping;
  metric.bis += Number(order.order_bis || 0);

  if (shipping <= 0.01) metric.freeShippingOrders += 1;
  else metric.paidShippingOrders += 1;
}

function finalize(metric) {
  metric.subtotal = round(metric.subtotal);
  metric.grandTotal = round(metric.grandTotal);
  metric.tax = round(metric.tax);
  metric.shippingCollected = round(metric.shippingCollected);
  metric.bis = round(metric.bis);
  metric.avgOrderSubtotal = round(metric.subtotal / Math.max(metric.orders, 1));
  metric.avgOrderGrandTotal = round(metric.grandTotal / Math.max(metric.orders, 1));
  metric.avgItemsPerOrder = round(metric.qty / Math.max(metric.orders, 1));
  metric.freeShippingOrderPct = pct(metric.freeShippingOrders, metric.orders);
  metric.shippingCollectedPerOrder = round(metric.shippingCollected / Math.max(metric.orders, 1));
  return metric;
}

function addDistributionShares(summary, buckets) {
  for (const bucket of Object.values(buckets)) {
    bucket.orderSharePct = pct(bucket.orders, summary.orders);
    bucket.subtotalSharePct = pct(bucket.subtotal, summary.subtotal);
  }
  return buckets;
}

function buildKpis(summary, buckets) {
  const thresholdBandOrders =
    buckets.promo_band_199_to_249.orders + buckets.promo_band_250_to_299.orders + buckets.promo_band_300_to_349.orders;
  const thresholdBandSubtotal =
    buckets.promo_band_199_to_249.subtotal + buckets.promo_band_250_to_299.subtotal + buckets.promo_band_300_to_349.subtotal;
  const thresholdBandQty =
    buckets.promo_band_199_to_249.qty + buckets.promo_band_250_to_299.qty + buckets.promo_band_300_to_349.qty;

  return {
    thresholdBandOrders: round(thresholdBandOrders, 2),
    thresholdBandOrderSharePct: pct(thresholdBandOrders, summary.orders),
    thresholdBandSubtotal: round(thresholdBandSubtotal),
    thresholdBandSubtotalSharePct: pct(thresholdBandSubtotal, summary.subtotal),
    thresholdBandAvgItemsPerOrder: round(thresholdBandQty / Math.max(thresholdBandOrders, 1)),
    highValueOrderSharePct: buckets.standard_free_shipping_350_plus.orderSharePct,
    highValueSubtotalSharePct: buckets.standard_free_shipping_350_plus.subtotalSharePct,
    paidShippingOrderSharePct: pct(summary.paidShippingOrders, summary.orders),
  };
}

function summarizeOrders(orders) {
  const summary = emptyMetric();
  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket.key, { ...emptyMetric(), label: bucket.label }]));
  const byDay = new Map();

  for (const order of orders) {
    const subtotal = Number(order.subtotal || 0);
    const bucket = buckets[getBucket(subtotal).key];
    const day = String(order.created_at || '').slice(0, 10);

    if (!byDay.has(day)) byDay.set(day, emptyMetric());

    for (const metric of [summary, bucket, byDay.get(day)]) {
      addOrder(metric, order);
    }
  }

  const finalizedSummary = finalize(summary);
  const finalizedBuckets = addDistributionShares(
    finalizedSummary,
    Object.fromEntries(Object.entries(buckets).map(([key, metric]) => [key, finalize(metric)]))
  );

  return {
    summary: finalizedSummary,
    kpis: buildKpis(finalizedSummary, finalizedBuckets),
    buckets: finalizedBuckets,
    byDay: Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, metric]) => ({ day, ...finalize(metric) })),
  };
}

function compareMetric(current, baseline) {
  return {
    ordersDelta: current.orders - baseline.orders,
    ordersDeltaPct: pct(current.orders - baseline.orders, baseline.orders),
    subtotalDelta: round(current.subtotal - baseline.subtotal),
    subtotalDeltaPct: pct(current.subtotal - baseline.subtotal, baseline.subtotal),
    avgOrderSubtotalDelta: round(current.avgOrderSubtotal - baseline.avgOrderSubtotal),
    avgItemsPerOrderDelta: round(current.avgItemsPerOrder - baseline.avgItemsPerOrder),
    shippingCollectedDelta: round(current.shippingCollected - baseline.shippingCollected),
    freeShippingOrderPctDelta: round((current.freeShippingOrderPct || 0) - (baseline.freeShippingOrderPct || 0), 1),
  };
}

function addMetric(target, source) {
  for (const key of ['orders', 'qty', 'subtotal', 'grandTotal', 'tax', 'shippingCollected', 'bis', 'freeShippingOrders', 'paidShippingOrders']) {
    target[key] += Number(source[key] || 0);
  }
}

function divideMetric(metric, divisor) {
  for (const key of ['orders', 'qty', 'subtotal', 'grandTotal', 'tax', 'shippingCollected', 'bis', 'freeShippingOrders', 'paidShippingOrders']) {
    metric[key] = Number(metric[key] || 0) / divisor;
  }
  return metric;
}

function buildAverageBaseline(windows, keys) {
  const summary = emptyMetric();
  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket.key, { ...emptyMetric(), label: bucket.label }]));

  for (const key of keys) {
    addMetric(summary, windows[key].summary);
    for (const bucket of BUCKETS) {
      addMetric(buckets[bucket.key], windows[key].buckets[bucket.key]);
    }
  }

  const finalizedSummary = finalize(divideMetric(summary, keys.length));
  const finalizedBuckets = addDistributionShares(
    finalizedSummary,
    Object.fromEntries(
      Object.entries(buckets).map(([key, metric]) => [key, finalize(divideMetric(metric, keys.length))])
    )
  );

  return {
    label: `Previous ${keys.length} week average`,
    weeksIncluded: keys,
    summary: finalizedSummary,
    kpis: buildKpis(finalizedSummary, finalizedBuckets),
    buckets: finalizedBuckets,
  };
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || {});
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

async function fetchOrders(start, end) {
  return prisma.order.findMany({
    where: {
      created_at: { gte: `${start} 00:00:00`, lte: `${end} 23:59:59` },
      NOT: [{ status: 'canceled' }, { status: 'closed' }],
    },
    orderBy: { created_at: 'asc' },
  });
}

async function main() {
  const windows = buildWindows();
  const baselineKeys = windows.filter((window) => window.key !== 'promo').map((window) => window.key);
  const result = {
    generatedAt: new Date().toISOString(),
    notes: [
      'This report compares order volume, revenue, average order value, and customer-paid shipping only; it intentionally excludes margin.',
      'Canceled and closed orders are excluded.',
    ],
    windows: {},
    baselines: {},
    comparisons: {},
  };

  for (const window of windows) {
    const orders = await fetchOrders(window.start, window.end);
    result.windows[window.key] = {
      label: window.label,
      start: window.start,
      end: window.end,
      ...summarizeOrders(orders),
    };
  }

  const promo = result.windows.promo;
  result.baselines.previous_4_week_average = buildAverageBaseline(result.windows, baselineKeys);

  for (const baselineKey of baselineKeys.slice().reverse()) {
    const baseline = result.windows[baselineKey];
    result.comparisons[`promo_vs_${baselineKey}`] = {
      summary: compareMetric(promo.summary, baseline.summary),
      buckets: Object.fromEntries(
        BUCKETS.map((bucket) => [bucket.key, compareMetric(promo.buckets[bucket.key], baseline.buckets[bucket.key])])
      ),
    };
  }

  result.comparisons.promo_vs_previous_4_week_average = {
    summary: compareMetric(promo.summary, result.baselines.previous_4_week_average.summary),
    buckets: Object.fromEntries(
      BUCKETS.map((bucket) => [
        bucket.key,
        compareMetric(promo.buckets[bucket.key], result.baselines.previous_4_week_average.buckets[bucket.key]),
      ])
    ),
  };

  const reportDir = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `free-shipping-199-promo-analysis-${stamp}.json`);
  const csvPath = path.join(reportDir, `free-shipping-199-promo-summary-${stamp}.csv`);
  const comparisonCsvPath = path.join(reportDir, `free-shipping-199-promo-comparisons-${stamp}.csv`);
  const distributionCsvPath = path.join(reportDir, `free-shipping-199-promo-distribution-${stamp}.csv`);

  const csvRows = [];
  for (const [windowKey, windowResult] of Object.entries(result.windows)) {
    csvRows.push({ window: windowKey, bucket: 'all', ...windowResult.summary });
    for (const [bucketKey, metric] of Object.entries(windowResult.buckets)) {
      csvRows.push({ window: windowKey, bucket: bucketKey, ...metric });
    }
  }
  for (const [baselineKey, baselineResult] of Object.entries(result.baselines)) {
    csvRows.push({ window: baselineKey, bucket: 'all', ...baselineResult.summary });
    for (const [bucketKey, metric] of Object.entries(baselineResult.buckets)) {
      csvRows.push({ window: baselineKey, bucket: bucketKey, ...metric });
    }
  }

  const comparisonRows = [];
  for (const [comparisonKey, comparison] of Object.entries(result.comparisons)) {
    comparisonRows.push({ comparison: comparisonKey, bucket: 'all', ...comparison.summary });
    for (const [bucketKey, metric] of Object.entries(comparison.buckets)) {
      comparisonRows.push({ comparison: comparisonKey, bucket: bucketKey, ...metric });
    }
  }

  const distributionRows = [];
  for (const [windowKey, windowResult] of Object.entries(result.windows)) {
    for (const [bucketKey, metric] of Object.entries(windowResult.buckets)) {
      distributionRows.push({
        period: windowKey,
        label: windowResult.label,
        start: windowResult.start,
        end: windowResult.end,
        orderSubtotal: metric.label,
        bucket: bucketKey,
        orders: metric.orders,
        orderSharePct: metric.orderSharePct,
        subtotal: metric.subtotal,
        subtotalSharePct: metric.subtotalSharePct,
        avgOrderSubtotal: metric.avgOrderSubtotal,
        avgItemsPerOrder: metric.avgItemsPerOrder,
      });
    }
  }
  for (const [baselineKey, baselineResult] of Object.entries(result.baselines)) {
    for (const [bucketKey, metric] of Object.entries(baselineResult.buckets)) {
      distributionRows.push({
        period: baselineKey,
        label: baselineResult.label,
        start: '',
        end: '',
        orderSubtotal: metric.label,
        bucket: bucketKey,
        orders: metric.orders,
        orderSharePct: metric.orderSharePct,
        subtotal: metric.subtotal,
        subtotalSharePct: metric.subtotalSharePct,
        avgOrderSubtotal: metric.avgOrderSubtotal,
        avgItemsPerOrder: metric.avgItemsPerOrder,
      });
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(csvPath, toCsv(csvRows));
  fs.writeFileSync(comparisonCsvPath, toCsv(comparisonRows));
  fs.writeFileSync(distributionCsvPath, toCsv(distributionRows));

  console.log(JSON.stringify({ jsonPath, csvPath, comparisonCsvPath, distributionCsvPath, summary: result.windows.promo.summary, kpis: result.windows.promo.kpis, comparisons: result.comparisons }, null, 2));
}

main()
  .catch((error) => {
    console.error('PROMO_ANALYSIS_ERROR', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });