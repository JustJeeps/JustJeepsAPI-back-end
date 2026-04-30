#!/usr/bin/env node

/**
 * Canceled Orders by Month Report
 *
 * Aggregates order counts with status "canceled" grouped by month, including total orders and cancel percentages.
 * Usage:
 *   node scripts/canceled-orders-report.js [--since=YYYY-MM]
 */

const fs = require('fs');
const path = require('path');

// Load .env when available so DATABASE_URL is set for Prisma scripts
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const prisma = require('../lib/prisma');

function resolveSinceDate() {
  const defaultSince = '2025-09';
  const arg = process.argv.slice(2).find(flag => flag.startsWith('--since='));

  const value = arg ? arg.split('=')[1] : defaultSince;
  if (!value) {
    return { label: defaultSince, date: new Date(`${defaultSince}-01T00:00:00Z`) };
  }

  if (!/^[0-9]{4}-[0-9]{2}$/.test(value)) {
    throw new Error(`Invalid --since value "${value}". Use YYYY-MM format.`);
  }

  const date = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unable to parse --since value "${value}".`);
  }

  return { label: value, date };
}

async function fetchCanceledOrdersByMonth(sinceDate) {
  // Group by month, including total orders to calculate per-month percentages
  const rows = await prisma.$queryRaw`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', ${sinceDate}),
        date_trunc('month', now()),
        interval '1 month'
      ) AS month_bucket
    ),
    parsed AS (
      SELECT
        CASE
          WHEN NULLIF(created_at, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN date_trunc('month', (NULLIF(created_at, '')::timestamp))
          ELSE NULL
        END AS month_bucket,
        status
      FROM "Order"
    ),
    aggregated AS (
      SELECT
        month_bucket,
        COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_orders,
        COUNT(*)::int AS total_orders
      FROM parsed
      WHERE month_bucket IS NOT NULL
        AND month_bucket >= date_trunc('month', ${sinceDate})
      GROUP BY 1
    )
    SELECT
      to_char(series.month_bucket, 'YYYY-MM') AS month,
      COALESCE(aggregated.canceled_orders, 0) AS canceled_orders,
      COALESCE(aggregated.total_orders, 0) AS total_orders,
      CASE
        WHEN COALESCE(aggregated.total_orders, 0) = 0 THEN 0
        ELSE ROUND(COALESCE(aggregated.canceled_orders, 0) * 100.0 / aggregated.total_orders, 2)
      END AS canceled_percentage
    FROM series
    LEFT JOIN aggregated
      ON aggregated.month_bucket = series.month_bucket
    WHERE series.month_bucket >= date_trunc('month', ${sinceDate})
    ORDER BY 1;
  `;

  return rows;
}

async function fetchOverallCanceledStats(sinceDate) {
  const [row] = await prisma.$queryRaw`
    WITH parsed AS (
      SELECT
        CASE
          WHEN NULLIF(created_at, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN (NULLIF(created_at, '')::timestamp)
          ELSE NULL
        END AS created_at_ts,
        status
      FROM "Order"
    )
    SELECT
      COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_orders,
      COUNT(*)::int AS total_orders
    FROM parsed
    WHERE created_at_ts IS NOT NULL
      AND created_at_ts >= ${sinceDate};
  `;

  return {
    canceledOrders: Number(row?.canceled_orders ?? 0),
    totalOrders: Number(row?.total_orders ?? 0),
  };
}

async function main() {
  try {
    const { label: sinceLabel, date: sinceDate } = resolveSinceDate();

    console.log(`📦 Canceled orders per month (since ${sinceLabel})\n`);
    const [data, overall] = await Promise.all([
      fetchCanceledOrdersByMonth(sinceDate),
      fetchOverallCanceledStats(sinceDate),
    ]);

    if (!data.length) {
      console.log('No canceled orders found.');
      return;
    }

    const formatted = data.map(row => {
      const canceledOrders = Number(row.canceled_orders) || 0;
      const totalOrders = Number(row.total_orders) || 0;
      return {
        month: row.month,
        valid_orders: Math.max(totalOrders - canceledOrders, 0),
        canceled_orders: canceledOrders,
        total_orders: totalOrders,
        canceled_percentage: Number(row.canceled_percentage) || 0,
      };
    });

    console.table(formatted);

    const totalCanceled = overall.canceledOrders;
    const totalOrders = overall.totalOrders;
    const totalValid = Math.max(totalOrders - totalCanceled, 0);
    const percent = totalOrders ? (totalCanceled / totalOrders) * 100 : 0;

    console.log(`\nTotal valid orders (non-canceled): ${totalValid}`);
    console.log(`\nTotal canceled orders: ${totalCanceled}`);
    console.log(`Total orders (all statuses): ${totalOrders}`);
    console.log(`Canceled percentage: ${percent.toFixed(2)}%`);
    console.log(`Date range: ${sinceLabel} onward`);
  } catch (error) {
    console.error('Failed to generate report:', error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
