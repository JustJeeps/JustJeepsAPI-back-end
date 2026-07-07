#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = require('../lib/prisma');

const CURRENT_THRESHOLD = Number(process.env.CURRENT_FREE_SHIPPING_THRESHOLD || 350);
const SIMULATED_THRESHOLD = Number(process.env.SIMULATED_FREE_SHIPPING_THRESHOLD || 250);
const DEFAULT_END_DATE = process.env.SIMULATION_END_DATE || '2026-06-28';
const PERIOD_MONTHS = (process.env.SIMULATION_MONTHS || '3,6')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const BANDS = [
  { key: 'under_250', label: 'Under $250', min: 0, max: 250 },
  { key: 'newly_eligible_250_to_299', label: '$250-$299.99', min: 250, max: 300 },
  { key: 'newly_eligible_300_to_349', label: '$300-$349.99', min: 300, max: 350 },
  { key: 'already_eligible_350_plus', label: '$350+', min: 350, max: Infinity },
];

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return round((numerator / denominator) * 100, 1);
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

function subtractMonths(dateString, months) {
  const date = parseDate(dateString);
  date.setUTCMonth(date.getUTCMonth() - months);
  return formatDate(date);
}

function getBand(subtotal) {
  return BANDS.find((band) => subtotal >= band.min && subtotal < band.max) || BANDS[0];
}

function parseShippingCost(value) {
  if (value == null) return null;
  const text = String(value).replace(/\u00a0/g, ' ').trim();
  if (!text) return null;

  const matches = [...text.matchAll(/(?:CA\$|\$)?\s*(\d{1,4}(?:\.\d{1,2})?)/gi)];
  const amounts = matches
    .filter((match) => {
      const fullMatch = match[0];
      const amount = match[1];
      return fullMatch.includes('$') || amount.includes('.');
    })
    .map((match) => Number(match[1]))
    .filter((amount) => Number.isFinite(amount) && amount >= 0 && amount <= 500);

  if (amounts.length === 0) return null;
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  return total > 0 && total <= 500 ? round(total) : null;
}

function emptyMetric() {
  return {
    orders: 0,
    subtotal: 0,
    grandTotal: 0,
    shippingCollected: 0,
    freeShippingOrders: 0,
    paidShippingOrders: 0,
    newlyEligibleOrders: 0,
    newlyEligiblePaidShippingOrders: 0,
    newlyEligibleSubtotal: 0,
    forgoneShippingRevenue: 0,
    newlyEligibleShippingCostKnownOrders: 0,
    newlyEligibleShippingCostMissingOrders: 0,
    newlyEligibleCarrierCostKnown: 0,
    newlyEligibleCarrierCostEstimated: 0,
  };
}

function addOrder(metric, order) {
  const subtotal = Number(order.subtotal || 0);
  const shippingCollected = Number(order.shipping_amount || 0);
  const newlyEligible = subtotal >= SIMULATED_THRESHOLD && subtotal < CURRENT_THRESHOLD;
  const paidShipping = shippingCollected > 0.01;

  metric.orders += 1;
  metric.subtotal += subtotal;
  metric.grandTotal += Number(order.grand_total || 0);
  metric.shippingCollected += shippingCollected;

  if (paidShipping) metric.paidShippingOrders += 1;
  else metric.freeShippingOrders += 1;

  if (newlyEligible) {
    metric.newlyEligibleOrders += 1;
    metric.newlyEligibleSubtotal += subtotal;
    if (paidShipping) {
      const shippingCost = parseShippingCost(order.shipping_cost_jj);
      metric.newlyEligiblePaidShippingOrders += 1;
      metric.forgoneShippingRevenue += shippingCollected;
      if (shippingCost == null) {
        metric.newlyEligibleShippingCostMissingOrders += 1;
      } else {
        metric.newlyEligibleShippingCostKnownOrders += 1;
        metric.newlyEligibleCarrierCostKnown += shippingCost;
      }
    }
  }
}

function finalize(metric, total) {
  metric.subtotal = round(metric.subtotal);
  metric.grandTotal = round(metric.grandTotal);
  metric.shippingCollected = round(metric.shippingCollected);
  metric.newlyEligibleSubtotal = round(metric.newlyEligibleSubtotal);
  metric.forgoneShippingRevenue = round(metric.forgoneShippingRevenue);
  metric.newlyEligibleCarrierCostKnown = round(metric.newlyEligibleCarrierCostKnown);
  const avgKnownCarrierCost = metric.newlyEligibleCarrierCostKnown / Math.max(metric.newlyEligibleShippingCostKnownOrders, 1);
  metric.newlyEligibleCarrierCostEstimated = round(
    metric.newlyEligibleCarrierCostKnown + metric.newlyEligibleShippingCostMissingOrders * avgKnownCarrierCost
  );
  metric.orderSharePct = pct(metric.orders, total.orders);
  metric.subtotalSharePct = pct(metric.subtotal, total.subtotal);
  metric.newlyEligibleOrderSharePct = pct(metric.newlyEligibleOrders, total.orders);
  metric.newlyEligibleSubtotalSharePct = pct(metric.newlyEligibleSubtotal, total.subtotal);
  metric.forgoneShippingRevenueSharePct = pct(metric.forgoneShippingRevenue, total.shippingCollected);
  metric.shippingCostCoveragePct = pct(metric.newlyEligibleShippingCostKnownOrders, metric.newlyEligiblePaidShippingOrders);
  metric.estimatedCarrierCostPctOfForgoneShippingRevenue = pct(
    metric.newlyEligibleCarrierCostEstimated,
    metric.forgoneShippingRevenue
  );
  metric.estimatedCarrierCostPctOfNewlyEligibleSubtotal = pct(
    metric.newlyEligibleCarrierCostEstimated,
    metric.newlyEligibleSubtotal
  );
  metric.avgSubtotal = round(metric.subtotal / Math.max(metric.orders, 1));
  metric.avgShippingCollected = round(metric.shippingCollected / Math.max(metric.orders, 1));
  metric.avgForgoneShippingPerNewlyEligiblePaidOrder = round(
    metric.forgoneShippingRevenue / Math.max(metric.newlyEligiblePaidShippingOrders, 1)
  );
  metric.avgEstimatedCarrierCostPerNewlyEligiblePaidOrder = round(
    metric.newlyEligibleCarrierCostEstimated / Math.max(metric.newlyEligiblePaidShippingOrders, 1)
  );
  return metric;
}

function summarizeOrders(orders) {
  const total = emptyMetric();
  const bands = Object.fromEntries(BANDS.map((band) => [band.key, { ...emptyMetric(), label: band.label }]));

  for (const order of orders) {
    const subtotal = Number(order.subtotal || 0);
    const band = bands[getBand(subtotal).key];
    addOrder(total, order);
    addOrder(band, order);
  }

  const finalizedTotal = finalize(total, total);
  const finalizedBands = Object.fromEntries(
    Object.entries(bands).map(([key, metric]) => [key, finalize(metric, finalizedTotal)])
  );

  return {
    summary: finalizedTotal,
    bands: finalizedBands,
    kpis: {
      newlyEligibleOrders: finalizedTotal.newlyEligibleOrders,
      newlyEligibleOrderSharePct: finalizedTotal.newlyEligibleOrderSharePct,
      newlyEligiblePaidShippingOrders: finalizedTotal.newlyEligiblePaidShippingOrders,
      newlyEligiblePaidShippingOrderSharePct: pct(finalizedTotal.newlyEligiblePaidShippingOrders, finalizedTotal.orders),
      newlyEligibleSubtotal: finalizedTotal.newlyEligibleSubtotal,
      newlyEligibleSubtotalSharePct: finalizedTotal.newlyEligibleSubtotalSharePct,
      forgoneShippingRevenue: finalizedTotal.forgoneShippingRevenue,
      forgoneShippingRevenueSharePct: finalizedTotal.forgoneShippingRevenueSharePct,
      newlyEligibleShippingCostKnownOrders: finalizedTotal.newlyEligibleShippingCostKnownOrders,
      newlyEligibleShippingCostMissingOrders: finalizedTotal.newlyEligibleShippingCostMissingOrders,
      shippingCostCoveragePct: finalizedTotal.shippingCostCoveragePct,
      newlyEligibleCarrierCostKnown: finalizedTotal.newlyEligibleCarrierCostKnown,
      newlyEligibleCarrierCostEstimated: finalizedTotal.newlyEligibleCarrierCostEstimated,
      estimatedCarrierCostPctOfForgoneShippingRevenue: finalizedTotal.estimatedCarrierCostPctOfForgoneShippingRevenue,
      estimatedCarrierCostPctOfNewlyEligibleSubtotal: finalizedTotal.estimatedCarrierCostPctOfNewlyEligibleSubtotal,
      avgForgoneShippingPerNewlyEligiblePaidOrder: finalizedTotal.avgForgoneShippingPerNewlyEligiblePaidOrder,
      avgEstimatedCarrierCostPerNewlyEligiblePaidOrder: finalizedTotal.avgEstimatedCarrierCostPerNewlyEligiblePaidOrder,
      currentFreeShippingOrderSharePct: pct(finalizedTotal.freeShippingOrders, finalizedTotal.orders),
      simulatedFreeShippingOrderSharePct: pct(
        finalizedTotal.freeShippingOrders + finalizedTotal.newlyEligiblePaidShippingOrders,
        finalizedTotal.orders
      ),
    },
  };
}

function addPolicyKpis(period, months) {
  period.kpis.monthlyAvgNewlyEligibleOrders = round(period.kpis.newlyEligibleOrders / months, 1);
  period.kpis.monthlyAvgForgoneShippingRevenue = round(period.kpis.forgoneShippingRevenue / months);
  period.kpis.annualizedForgoneShippingRevenue = round(period.kpis.monthlyAvgForgoneShippingRevenue * 12);
  period.kpis.monthlyAvgEstimatedCarrierCostAbsorbed = round(period.kpis.newlyEligibleCarrierCostEstimated / months);
  period.kpis.annualizedEstimatedCarrierCostAbsorbed = round(period.kpis.monthlyAvgEstimatedCarrierCostAbsorbed * 12);
  period.kpis.forgoneShippingPctOfNewlyEligibleSubtotal = pct(
    period.kpis.forgoneShippingRevenue,
    period.kpis.newlyEligibleSubtotal
  );
  period.kpis.freeShippingOrderShareIncreasePctPoints = round(
    period.kpis.simulatedFreeShippingOrderSharePct - period.kpis.currentFreeShippingOrderSharePct,
    1
  );
  return period;
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
    select: {
      entity_id: true,
      increment_id: true,
      created_at: true,
      subtotal: true,
      grand_total: true,
      shipping_amount: true,
      shipping_cost_jj: true,
      status: true,
    },
  });
}

async function main() {
  if (SIMULATED_THRESHOLD >= CURRENT_THRESHOLD) {
    throw new Error('SIMULATED_FREE_SHIPPING_THRESHOLD must be lower than CURRENT_FREE_SHIPPING_THRESHOLD');
  }

  const result = {
    generatedAt: new Date().toISOString(),
    currentThreshold: CURRENT_THRESHOLD,
    simulatedThreshold: SIMULATED_THRESHOLD,
    endDate: DEFAULT_END_DATE,
    notes: [
      `Newly eligible means order subtotal >= $${SIMULATED_THRESHOLD} and < $${CURRENT_THRESHOLD}.`,
      'Forgone shipping revenue is based on shipping_amount actually collected on those newly eligible orders.',
      'Estimated carrier cost absorbed uses shipping_cost_jj when it can be parsed as a reasonable currency amount; missing costs fall back to the known average for the same period/band.',
      'Canceled and closed orders are excluded.',
      'Default end date is the day before the June 29 promo so promo behavior does not contaminate the permanent-threshold simulation.',
    ],
    periods: {},
  };

  for (const months of PERIOD_MONTHS) {
    const start = subtractMonths(addDays(DEFAULT_END_DATE, 1), months);
    const end = DEFAULT_END_DATE;
    const key = `previous_${months}_months`;
    const orders = await fetchOrders(start, end);
    result.periods[key] = addPolicyKpis({
      label: `Previous ${months} months`,
      months,
      start,
      end,
      ...summarizeOrders(orders),
    }, months);
  }

  const reportDir = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `free-shipping-250-threshold-simulation-${stamp}.json`);
  const summaryCsvPath = path.join(reportDir, `free-shipping-250-threshold-simulation-summary-${stamp}.csv`);
  const bandCsvPath = path.join(reportDir, `free-shipping-250-threshold-simulation-bands-${stamp}.csv`);

  const summaryRows = [];
  const bandRows = [];
  for (const [periodKey, period] of Object.entries(result.periods)) {
    summaryRows.push({
      period: periodKey,
      label: period.label,
      start: period.start,
      end: period.end,
      totalOrders: period.summary.orders,
      totalSubtotal: period.summary.subtotal,
      totalShippingCollected: period.summary.shippingCollected,
      ...period.kpis,
    });

    for (const [bandKey, band] of Object.entries(period.bands)) {
      bandRows.push({
        period: periodKey,
        label: period.label,
        start: period.start,
        end: period.end,
        orderSubtotal: band.label,
        band: bandKey,
        orders: band.orders,
        orderSharePct: band.orderSharePct,
        subtotal: band.subtotal,
        subtotalSharePct: band.subtotalSharePct,
        shippingCollected: band.shippingCollected,
        newlyEligibleOrders: band.newlyEligibleOrders,
        newlyEligiblePaidShippingOrders: band.newlyEligiblePaidShippingOrders,
        newlyEligibleSubtotal: band.newlyEligibleSubtotal,
        forgoneShippingRevenue: band.forgoneShippingRevenue,
        newlyEligibleShippingCostKnownOrders: band.newlyEligibleShippingCostKnownOrders,
        newlyEligibleShippingCostMissingOrders: band.newlyEligibleShippingCostMissingOrders,
        shippingCostCoveragePct: band.shippingCostCoveragePct,
        newlyEligibleCarrierCostKnown: band.newlyEligibleCarrierCostKnown,
        newlyEligibleCarrierCostEstimated: band.newlyEligibleCarrierCostEstimated,
        estimatedCarrierCostPctOfForgoneShippingRevenue: band.estimatedCarrierCostPctOfForgoneShippingRevenue,
        estimatedCarrierCostPctOfNewlyEligibleSubtotal: band.estimatedCarrierCostPctOfNewlyEligibleSubtotal,
        avgForgoneShippingPerNewlyEligiblePaidOrder: band.avgForgoneShippingPerNewlyEligiblePaidOrder,
        avgEstimatedCarrierCostPerNewlyEligiblePaidOrder: band.avgEstimatedCarrierCostPerNewlyEligiblePaidOrder,
      });
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(summaryCsvPath, toCsv(summaryRows));
  fs.writeFileSync(bandCsvPath, toCsv(bandRows));

  console.log(JSON.stringify({ jsonPath, summaryCsvPath, bandCsvPath, periods: result.periods }, null, 2));
}

main()
  .catch((error) => {
    console.error('THRESHOLD_SIMULATION_ERROR', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });