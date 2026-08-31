#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const ExcelJS = require('exceljs');
const prisma = require('../lib/prisma');
const { getDateStringInTimezone } = require('../lib/reports/dates');

const DEFAULT_TIMEZONE = process.env.CRON_TIMEZONE || 'America/Toronto';
const DEFAULT_MONTHS = 3;
const DEFAULT_BUSINESS_START_HOUR = 8;
const DEFAULT_BUSINESS_END_HOUR = 18;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    months: DEFAULT_MONTHS,
    timeZone: DEFAULT_TIMEZONE,
    businessStartHour: DEFAULT_BUSINESS_START_HOUR,
    businessEndHour: DEFAULT_BUSINESS_END_HOUR,
    belowRatio: 0.5,
    minBaselineAverage: 0.25,
    writeCsv: true,
    output: null,
    endDate: null,
    asOf: null,
  };

  for (const arg of argv) {
    if (arg === '--no-csv') options.writeCsv = false;
    else if (arg.startsWith('--months=')) options.months = Number(arg.split('=')[1]);
    else if (arg.startsWith('--timezone=')) options.timeZone = arg.split('=')[1];
    else if (arg.startsWith('--business-start-hour=')) options.businessStartHour = Number(arg.split('=')[1]);
    else if (arg.startsWith('--business-end-hour=')) options.businessEndHour = Number(arg.split('=')[1]);
    else if (arg.startsWith('--below-ratio=')) options.belowRatio = Number(arg.split('=')[1]);
    else if (arg.startsWith('--min-baseline-average=')) options.minBaselineAverage = Number(arg.split('=')[1]);
    else if (arg.startsWith('--end=')) options.endDate = arg.split('=')[1];
    else if (arg.startsWith('--as-of=')) options.asOf = arg.split('=')[1];
    else if (arg.startsWith('--output=')) options.output = arg.split('=')[1];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.months) || options.months <= 0) {
    throw new Error('--months must be a positive integer.');
  }
  if (!Number.isInteger(options.businessStartHour) || options.businessStartHour < 0 || options.businessStartHour > 23) {
    throw new Error('--business-start-hour must be an integer from 0 to 23.');
  }
  if (!Number.isInteger(options.businessEndHour) || options.businessEndHour < 1 || options.businessEndHour > 24) {
    throw new Error('--business-end-hour must be an integer from 1 to 24.');
  }
  if (options.businessStartHour >= options.businessEndHour) {
    throw new Error('--business-start-hour must be less than --business-end-hour.');
  }
  if (!Number.isFinite(options.belowRatio) || options.belowRatio <= 0 || options.belowRatio >= 1) {
    throw new Error('--below-ratio must be greater than 0 and less than 1.');
  }
  if (!Number.isFinite(options.minBaselineAverage) || options.minBaselineAverage < 0) {
    throw new Error('--min-baseline-average must be zero or greater.');
  }
  if (options.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.endDate)) {
    throw new Error('--end must use YYYY-MM-DD format.');
  }
  if (options.asOf && Number.isNaN(new Date(options.asOf).getTime())) {
    throw new Error('--as-of must be a valid date/time, preferably an ISO timestamp with timezone offset.');
  }

  return options;
}

function printHelp() {
  console.log(`Order Time Summary Report\n\nUsage:\n  node scripts/order-time-summary-report.js [options]\n\nOptions:\n  --months=3                          Months to include, ending on --end or today in the store timezone.\n  --end=YYYY-MM-DD                    End date in the store timezone.\n  --timezone=America/Toronto          Store timezone for grouping orders.\n  --as-of=2026-08-26T09:26:00-04:00  Optional report cutoff timestamp; defaults to now.\n  --business-start-hour=8             First business-hour bucket included in gap detection.\n  --business-end-hour=18              Exclusive ending business-hour bucket for gap detection.\n  --below-ratio=0.5                   Recent average must be at or below this ratio of baseline to flag.\n  --min-baseline-average=0.25         Ignore low-volume baseline hours below this daily average.\n  --output=reports/file.xlsx          Optional workbook output path.\n  --no-csv                            Do not write companion CSV files.`);
}

function parseDateOnly(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) throw new Error(`Invalid date: ${dateString}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatDateParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateString, days) {
  const { year, month, day } = parseDateOnly(dateString);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addMonths(dateString, months) {
  const { year, month, day } = parseDateOnly(dateString);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return formatDateParts(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  for (let current = startDate; current <= endDate; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function getTimezoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function getLocalAsOf(asOfValue, timeZone) {
  const utcDate = asOfValue ? new Date(asOfValue) : new Date();
  const parts = getTimezoneParts(utcDate, timeZone);
  return {
    utcDate,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getTimezoneOffsetMs(utcDate, timeZone) {
  const parts = getTimezoneParts(utcDate, timeZone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return localAsUtc - utcDate.getTime();
}

function localDateTimeToUtcDate(dateString, hour, minute, second, timeZone) {
  const { year, month, day } = parseDateOnly(dateString);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcDate = new Date(localAsUtc - getTimezoneOffsetMs(new Date(localAsUtc), timeZone));
  utcDate = new Date(localAsUtc - getTimezoneOffsetMs(utcDate, timeZone));
  return utcDate;
}

function formatUtcForMagento(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseOrderLocalDateTime(value, timeZone) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const explicitOffset = /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!match && !explicitOffset) return null;

  const date = explicitOffset
    ? new Date(raw)
    : new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4] || '00'}:${match[5] || '00'}:${match[6] || '00'}Z`);
  if (Number.isNaN(date.getTime())) return null;

  const parts = getTimezoneParts(date, timeZone);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  if (hour === 24) return '12 AM';
  return `${hour - 12} PM`;
}

function formatHourRange(hour) {
  return `${formatHour(hour)}-${formatHour(hour + 1)}`;
}

function formatTime(hour, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatTimeFromHourFloat(hourFloat) {
  const hour = Math.floor(hourFloat);
  const minute = Math.round((hourFloat - hour) * 60);
  if (minute === 60) return formatTime(hour + 1, 0);
  return formatTime(hour, minute);
}

function getWeekday(dateString) {
  const { year, month, day } = parseDateOnly(dateString);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function buildEmptyGrid(dates) {
  const byDate = new Map();
  const byDateHour = new Map();

  for (const date of dates) {
    byDate.set(date, { date, orderCount: 0, grandTotal: 0 });
    for (let hour = 0; hour < 24; hour += 1) {
      const key = `${date}|${hour}`;
      byDateHour.set(key, { date, hour, hourRange: formatHourRange(hour), orderCount: 0, grandTotal: 0 });
    }
  }

  return { byDate, byDateHour };
}

function addOrderToSummaries(order, localDateTime, summaries) {
  const amount = Number(order.grand_total || 0);
  const daily = summaries.byDate.get(localDateTime.date);
  const hourly = summaries.byDateHour.get(`${localDateTime.date}|${localDateTime.hour}`);

  if (!daily || !hourly) return;

  for (const bucket of [daily, hourly]) {
    bucket.orderCount += 1;
    bucket.grandTotal += amount;
  }
}

function findZeroOrderGaps(dates, byDateHour, options, cutoffByDate) {
  const gaps = [];

  for (const date of dates) {
    const cutoffHour = cutoffByDate.get(date);
    if (!Number.isFinite(cutoffHour) || cutoffHour <= options.businessStartHour) continue;

    const effectiveEndHour = Math.min(options.businessEndHour, cutoffHour);
    let gapStart = null;

    for (let hour = options.businessStartHour; hour < Math.ceil(effectiveEndHour); hour += 1) {
      if (hour >= effectiveEndHour) break;
      const count = byDateHour.get(`${date}|${hour}`).orderCount;

      if (count === 0 && gapStart === null) {
        gapStart = hour;
      }

      if (count > 0 && gapStart !== null) {
        const gapEnd = hour;
        const durationHours = gapEnd - gapStart;
        if (durationHours >= 1) {
          gaps.push({
            date,
            weekday: getWeekday(date),
            startTime: formatTime(gapStart),
            endTime: formatTime(gapEnd),
            durationHours,
            gapType: durationHours >= 2 ? '2+ hours' : '1+ hour',
          });
        }
        gapStart = null;
      }
    }

    if (gapStart !== null) {
      const durationHours = round(effectiveEndHour - gapStart, 2);
      if (durationHours >= 1) {
        gaps.push({
          date,
          weekday: getWeekday(date),
          startTime: formatTime(gapStart),
          endTime: formatTimeFromHourFloat(effectiveEndHour),
          durationHours,
          gapType: durationHours >= 2 ? '2+ hours' : '1+ hour',
        });
      }
    }
  }

  return gaps;
}

function buildHourlyAverages(dates, byDateHour) {
  return Array.from({ length: 24 }, (_, hour) => {
    const buckets = dates.map((date) => byDateHour.get(`${date}|${hour}`));
    const totalOrders = buckets.reduce((total, bucket) => total + bucket.orderCount, 0);
    const grandTotal = buckets.reduce((total, bucket) => total + bucket.grandTotal, 0);
    return {
      hour,
      hourRange: formatHourRange(hour),
      totalOrders,
      daysIncluded: dates.length,
      averageOrdersPerDay: round(totalOrders / Math.max(dates.length, 1), 2),
      averageGrandTotalPerDay: round(grandTotal / Math.max(dates.length, 1), 2),
    };
  });
}

function buildRecentComparison(completedDates, byDateHour, options) {
  const recentDates = completedDates.slice(-7);
  const recentDateSet = new Set(recentDates);
  const baselineDates = completedDates.filter((date) => recentDateSet.has(date) === false);

  return Array.from({ length: 24 }, (_, hour) => {
    const recentTotal = recentDates.reduce((total, date) => total + byDateHour.get(`${date}|${hour}`).orderCount, 0);
    const recentAverage = recentTotal / Math.max(recentDates.length, 1);
    let expectedRecentTotal = 0;
    let matchedBaselineDays = 0;

    for (const recentDate of recentDates) {
      const weekday = getWeekday(recentDate);
      const matches = baselineDates.filter((date) => getWeekday(date) === weekday);
      const matchTotal = matches.reduce((total, date) => total + byDateHour.get(`${date}|${hour}`).orderCount, 0);
      expectedRecentTotal += matchTotal / Math.max(matches.length, 1);
      matchedBaselineDays += matches.length;
    }

    const baseline = expectedRecentTotal / Math.max(recentDates.length, 1);
    const ratioToExpected = expectedRecentTotal ? recentTotal / expectedRecentTotal : null;
    const significantlyBelow = baseline >= options.minBaselineAverage && recentAverage <= baseline * options.belowRatio;

    return {
      hour,
      hourRange: formatHourRange(hour),
      recentPeriodStart: recentDates[0] || '',
      recentPeriodEnd: recentDates[recentDates.length - 1] || '',
      recent7DayOrders: recentTotal,
      expected7DayOrders: round(expectedRecentTotal, 2),
      matchedBaselineDays,
      recentAveragePerDay: round(recentAverage, 2),
      weekdayHourAveragePerDay: round(baseline, 2),
      deltaVsAveragePerDay: round(recentAverage - baseline, 2),
      percentOfExpected: ratioToExpected === null ? null : round(ratioToExpected * 100, 1),
      significantlyBelowNormal: significantlyBelow ? 'YES' : '',
    };
  });
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || {});
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

function addSheet(workbook, name, rows, columns) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    sheet.addRow(row);
  }

  for (const column of sheet.columns) {
    const headerLength = String(column.header || '').length;
    const maxValueLength = column.values.slice(1).reduce((max, value) => Math.max(max, String(value ?? '').length), 0);
    column.width = Math.min(Math.max(headerLength, maxValueLength, 10) + 2, 42);
  }

  return sheet;
}

function writeCsvFiles(basePath, sheets) {
  const csvDir = basePath.replace(/\.xlsx$/i, '-csv');
  fs.mkdirSync(csvDir, { recursive: true });

  const paths = [];
  for (const sheet of sheets) {
    const fileName = `${sheet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.csv`;
    const outputPath = path.join(csvDir, fileName);
    fs.writeFileSync(outputPath, toCsv(sheet.rows), 'utf8');
    paths.push(outputPath);
  }
  return paths;
}

async function fetchOrders(startUtc, endUtc) {
  return prisma.order.findMany({
    where: {
      created_at: { gte: startUtc, lte: endUtc },
    },
    select: {
      increment_id: true,
      created_at: true,
      status: true,
      grand_total: true,
    },
    orderBy: { created_at: 'asc' },
  });
}

function buildReportRows(orders, options) {
  const asOf = getLocalAsOf(options.asOf, options.timeZone);
  const requestedEndDate = options.endDate || asOf.date;
  const endDate = requestedEndDate > asOf.date ? asOf.date : requestedEndDate;
  const startDate = addMonths(endDate, -options.months);
  const dates = enumerateDates(startDate, endDate);
  const completedDates = dates.filter((date) => date < asOf.date || endDate < asOf.date);
  const summaries = buildEmptyGrid(dates);
  const parsedOrders = [];
  const skippedOrders = [];

  for (const order of orders) {
    const localDateTime = parseOrderLocalDateTime(order.created_at, options.timeZone);
    if (!localDateTime || localDateTime.date < startDate || localDateTime.date > endDate) {
      skippedOrders.push(order);
      continue;
    }
    addOrderToSummaries(order, localDateTime, summaries);
    parsedOrders.push({ ...order, localDate: localDateTime.date, localHour: localDateTime.hour });
  }

  const cutoffByDate = new Map(dates.map((date) => {
    if (date < asOf.date || endDate < asOf.date) return [date, 24];
    if (date > asOf.date) return [date, 0];
    return [date, asOf.hour + (asOf.minute / 60) + (asOf.second / 3600)];
  }));

  const dailySummary = dates.map((date) => {
    const day = summaries.byDate.get(date);
    return {
      date,
      weekday: getWeekday(date),
      totalOrders: day.orderCount,
      grandTotal: round(day.grandTotal, 2),
      partialDay: date === asOf.date ? 'YES' : '',
    };
  });

  const hourlyBreakdown = dates.flatMap((date) => {
    const cutoffHour = cutoffByDate.get(date);
    return Array.from({ length: 24 }, (_, hour) => {
      if (hour >= cutoffHour) return null;
      const bucket = summaries.byDateHour.get(`${date}|${hour}`);
      return {
        date,
        weekday: getWeekday(date),
        hour,
        hourRange: bucket.hourRange,
        orderCount: bucket.orderCount,
        grandTotal: round(bucket.grandTotal, 2),
        partialHour: date === asOf.date && hour === asOf.hour ? 'YES' : '',
      };
    }).filter(Boolean);
  });

  const hourlyAverages = buildHourlyAverages(completedDates, summaries.byDateHour);
  const orderGaps = findZeroOrderGaps(dates, summaries.byDateHour, options, cutoffByDate);
  const recentComparison = buildRecentComparison(completedDates, summaries.byDateHour, options);

  const reportInfo = [{
    generatedAt: new Date().toISOString(),
    asOfLocal: `${asOf.date} ${formatTime(asOf.hour, asOf.minute)}`,
    timeZone: options.timeZone,
    startDate,
    endDate,
    requestedEndDate,
    monthsRequested: options.months,
    daysIncluded: dates.length,
    completedDaysUsedForAverages: completedDates.length,
    ordersCreated: parsedOrders.length,
    skippedUnparseableOrders: skippedOrders.length,
    excludedStatuses: 'none',
    businessHours: `${formatHour(options.businessStartHour)}-${formatHour(options.businessEndHour)}`,
    significantLowRule: `recent completed-day average <= ${options.belowRatio * 100}% of weekday/hour baseline and baseline >= ${options.minBaselineAverage}`,
  }];

  return { reportInfo, dailySummary, hourlyBreakdown, hourlyAverages, orderGaps, recentComparison, startDate, endDate };
}

async function main() {
  const options = parseArgs();
  const asOf = getLocalAsOf(options.asOf, options.timeZone);
  const requestedEndDate = options.endDate || getDateStringInTimezone(asOf.utcDate, options.timeZone);
  const endDate = requestedEndDate > asOf.date ? asOf.date : requestedEndDate;
  const startDate = addMonths(endDate, -options.months);
  const startUtc = formatUtcForMagento(localDateTimeToUtcDate(startDate, 0, 0, 0, options.timeZone));
  const endUtc = endDate === asOf.date
    ? formatUtcForMagento(asOf.utcDate)
    : formatUtcForMagento(localDateTimeToUtcDate(endDate, 23, 59, 59, options.timeZone));
  const orders = await fetchOrders(startUtc, endUtc);
  const rows = buildReportRows(orders, { ...options, endDate, asOf: asOf.utcDate.toISOString() });

  const reportDir = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.join(reportDir, `order-time-summary-${rows.startDate}-to-${rows.endDate}-${stamp}.xlsx`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JustJeepsAPI';
  workbook.created = new Date();

  const sheets = [
    {
      name: 'Report Info',
      rows: rows.reportInfo,
      columns: [
        { header: 'Generated At', key: 'generatedAt' },
        { header: 'As Of Local', key: 'asOfLocal' },
        { header: 'Timezone', key: 'timeZone' },
        { header: 'Start Date', key: 'startDate' },
        { header: 'End Date', key: 'endDate' },
        { header: 'Requested End Date', key: 'requestedEndDate' },
        { header: 'Months Requested', key: 'monthsRequested' },
        { header: 'Days Included', key: 'daysIncluded' },
        { header: 'Completed Days Used For Averages', key: 'completedDaysUsedForAverages' },
        { header: 'Orders Created', key: 'ordersCreated' },
        { header: 'Skipped Unparseable Orders', key: 'skippedUnparseableOrders' },
        { header: 'Status Exclusions', key: 'excludedStatuses' },
        { header: 'Business Hours', key: 'businessHours' },
        { header: 'Significant Low Rule', key: 'significantLowRule' },
      ],
    },
    {
      name: 'Daily Summary',
      rows: rows.dailySummary,
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Weekday', key: 'weekday' },
        { header: 'Orders Created', key: 'totalOrders' },
        { header: 'Grand Total', key: 'grandTotal' },
        { header: 'Partial Day', key: 'partialDay' },
      ],
    },
    {
      name: 'Hourly Breakdown',
      rows: rows.hourlyBreakdown,
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Weekday', key: 'weekday' },
        { header: 'Hour', key: 'hour' },
        { header: 'Hour Range', key: 'hourRange' },
        { header: 'Orders Created', key: 'orderCount' },
        { header: 'Grand Total', key: 'grandTotal' },
        { header: 'Partial Hour', key: 'partialHour' },
      ],
    },
    {
      name: 'Hourly Averages',
      rows: rows.hourlyAverages,
      columns: [
        { header: 'Hour', key: 'hour' },
        { header: 'Hour Range', key: 'hourRange' },
        { header: 'Orders Created', key: 'totalOrders' },
        { header: 'Completed Days Included', key: 'daysIncluded' },
        { header: 'Avg Orders Created Per Completed Day', key: 'averageOrdersPerDay' },
        { header: 'Avg Grand Total Per Completed Day', key: 'averageGrandTotalPerDay' },
      ],
    },
    {
      name: 'Order Gaps',
      rows: rows.orderGaps,
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Weekday', key: 'weekday' },
        { header: 'Start Time', key: 'startTime' },
        { header: 'End Time', key: 'endTime' },
        { header: 'Gap Duration Hours', key: 'durationHours' },
        { header: 'Gap Type', key: 'gapType' },
      ],
    },
    {
      name: 'Recent vs Average',
      rows: rows.recentComparison,
      columns: [
        { header: 'Hour', key: 'hour' },
        { header: 'Hour Range', key: 'hourRange' },
        { header: 'Recent Period Start', key: 'recentPeriodStart' },
        { header: 'Recent Period End', key: 'recentPeriodEnd' },
        { header: 'Recent 7-Day Orders Created', key: 'recent7DayOrders' },
        { header: 'Expected 7-Day Orders Created', key: 'expected7DayOrders' },
        { header: 'Matched Baseline Days', key: 'matchedBaselineDays' },
        { header: 'Recent Avg Orders Created Per Day', key: 'recentAveragePerDay' },
        { header: 'Weekday/Hour Avg Orders Created Per Day', key: 'weekdayHourAveragePerDay' },
        { header: 'Delta vs Avg Per Day', key: 'deltaVsAveragePerDay' },
        { header: 'Percent of Expected', key: 'percentOfExpected' },
        { header: 'Significantly Below Normal', key: 'significantlyBelowNormal' },
      ],
    },
  ];

  for (const sheet of sheets) {
    addSheet(workbook, sheet.name, sheet.rows, sheet.columns);
  }

  await workbook.xlsx.writeFile(outputPath);
  const csvPaths = options.writeCsv ? writeCsvFiles(outputPath, sheets) : [];

  console.log(JSON.stringify({
    outputPath,
    csvPaths,
    startDate: rows.startDate,
    endDate: rows.endDate,
    asOfLocal: rows.reportInfo[0].asOfLocal,
    ordersCreated: rows.reportInfo[0].ordersCreated,
    gapCount: rows.orderGaps.length,
    significantlyBelowHours: rows.recentComparison.filter((row) => row.significantlyBelowNormal === 'YES').length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('ORDER_TIME_SUMMARY_REPORT_ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
