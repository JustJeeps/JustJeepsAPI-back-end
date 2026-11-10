// Rough Country competitive pricing report.
//
// Compares the Just Jeeps effective selling price against competitor prices
// (TDOT, Lowriders, Parts Engine, Niagara Jeeps). The Product.price column
// does NOT include the site-wide Rough Country discount, so the effective
// price is computed as price * (1 - discount). Default discount is 15%,
// override with --discount=<percent>.
//
// Usage: node scripts/rough-country-competitive-report.js [--discount=15]

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ExcelJS = require('exceljs');
const prisma = require('../lib/prisma');

const BRAND = 'Rough Country';
const COMPETITORS = ['TDOT', 'Lowriders', 'Parts Engine', 'Niagara Jeeps'];

function getDiscountRate() {
  const arg = process.argv.find((a) => a.startsWith('--discount='));
  const pct = arg ? Number(arg.split('=')[1]) : 15;
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) {
    throw new Error(`Invalid discount percent: ${arg}`);
  }
  return pct / 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function run() {
  const discountRate = getDiscountRate();

  const products = await prisma.product.findMany({
    where: {
      brand_name: BRAND,
      status: 1,
      price: { gt: 0 },
    },
    select: {
      sku: true,
      searchable_sku: true,
      name: true,
      price: true,
      MAP: true,
      competitorProducts: {
        select: {
          competitor_price: true,
          product_url: true,
          competitor: { select: { name: true } },
        },
      },
    },
    orderBy: { sku: 'asc' },
  });

  const workbook = new ExcelJS.Workbook();
  const detailSheet = workbook.addWorksheet('Competitive Detail');

  const columns = [
    { header: 'JJ SKU', key: 'sku', width: 16 },
    { header: 'Manuf. SKU', key: 'searchable_sku', width: 14 },
    { header: 'Name', key: 'name', width: 60 },
    { header: 'DB Price', key: 'db_price', width: 11 },
    { header: `JJ Price (-${round2(discountRate * 100)}%)`, key: 'jj_price', width: 14 },
    { header: 'MAP', key: 'map', width: 11 },
  ];
  for (const comp of COMPETITORS) {
    columns.push({ header: `${comp} Price`, key: `${comp}_price`, width: 14 });
    columns.push({ header: `${comp} Diff %`, key: `${comp}_diff_pct`, width: 12 });
  }
  columns.push(
    { header: 'Lowest Competitor', key: 'lowest_name', width: 18 },
    { header: 'Lowest Comp. Price', key: 'lowest_price', width: 16 },
    { header: 'JJ vs Lowest ($)', key: 'diff_lowest_abs', width: 14 },
    { header: 'JJ vs Lowest (%)', key: 'diff_lowest_pct', width: 14 },
    { header: 'Position', key: 'position', width: 22 },
    { header: '# Competitors Matched', key: 'matched', width: 10 },
  );
  detailSheet.columns = columns;
  detailSheet.getRow(1).font = { bold: true };
  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];
  detailSheet.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };

  const stats = {};
  for (const comp of COMPETITORS) {
    stats[comp] = { matched: 0, cheaper: 0, tied: 0, moreExpensive: 0, diffPcts: [] };
  }
  const overall = {
    total: products.length,
    withCompetitorData: 0,
    cheapestOverall: 0,
    tiedOverall: 0,
    moreExpensiveOverall: 0,
  };

  for (const product of products) {
    const jjPrice = round2(product.price * (1 - discountRate));
    const row = {
      sku: product.sku,
      searchable_sku: product.searchable_sku,
      name: product.name,
      db_price: product.price,
      jj_price: jjPrice,
      map: product.MAP,
    };

    let lowest = null;
    let matched = 0;
    for (const comp of COMPETITORS) {
      const cp = product.competitorProducts.find((c) => c.competitor?.name === comp);
      if (!cp || !(cp.competitor_price > 0)) continue;
      matched += 1;
      const compPrice = round2(cp.competitor_price);
      // Positive diff % = we are more expensive than this competitor.
      const diffPct = round2(((jjPrice - compPrice) / compPrice) * 100);
      row[`${comp}_price`] = compPrice;
      row[`${comp}_diff_pct`] = diffPct;

      const s = stats[comp];
      s.matched += 1;
      s.diffPcts.push(diffPct);
      if (jjPrice < compPrice) s.cheaper += 1;
      else if (jjPrice > compPrice) s.moreExpensive += 1;
      else s.tied += 1;

      if (!lowest || compPrice < lowest.price) {
        lowest = { name: comp, price: compPrice };
      }
    }

    row.matched = matched;
    if (lowest) {
      overall.withCompetitorData += 1;
      row.lowest_name = lowest.name;
      row.lowest_price = lowest.price;
      row.diff_lowest_abs = round2(jjPrice - lowest.price);
      row.diff_lowest_pct = round2(((jjPrice - lowest.price) / lowest.price) * 100);
      if (jjPrice < lowest.price) {
        row.position = 'Cheapest';
        overall.cheapestOverall += 1;
      } else if (jjPrice === lowest.price) {
        row.position = 'Tied for cheapest';
        overall.tiedOverall += 1;
      } else {
        row.position = 'More expensive';
        overall.moreExpensiveOverall += 1;
      }
    } else {
      row.position = 'No competitor data';
    }

    const added = detailSheet.addRow(row);
    const fillFor = {
      Cheapest: 'FFC6EFCE',
      'Tied for cheapest': 'FFFFF2CC',
      'More expensive': 'FFFFC7CE',
    };
    const fill = fillFor[row.position];
    if (fill) {
      added.getCell('position').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: fill },
      };
    }
  }

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 44 },
    { header: 'Value', key: 'value', width: 18 },
  ];
  summarySheet.getRow(1).font = { bold: true };

  const pct = (part, whole) => (whole ? `${round2((part / whole) * 100)}%` : 'n/a');
  const avg = (arr) => (arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : 'n/a');
  const median = (arr) => {
    if (!arr.length) return 'n/a';
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
  };

  summarySheet.addRows([
    { metric: 'Brand', value: BRAND },
    { metric: 'Discount applied to DB price', value: `${round2(discountRate * 100)}%` },
    { metric: 'Active products (status 1, price > 0)', value: overall.total },
    { metric: 'Products with at least one competitor price', value: overall.withCompetitorData },
    { metric: 'JJ cheapest vs all matched competitors', value: `${overall.cheapestOverall} (${pct(overall.cheapestOverall, overall.withCompetitorData)})` },
    { metric: 'JJ tied for cheapest', value: `${overall.tiedOverall} (${pct(overall.tiedOverall, overall.withCompetitorData)})` },
    { metric: 'JJ more expensive than lowest competitor', value: `${overall.moreExpensiveOverall} (${pct(overall.moreExpensiveOverall, overall.withCompetitorData)})` },
    {},
  ]);

  const headerRow = summarySheet.addRow({ metric: 'Per-competitor breakdown (vs JJ discounted price)' });
  headerRow.font = { bold: true };
  for (const comp of COMPETITORS) {
    const s = stats[comp];
    summarySheet.addRows([
      {},
      { metric: `${comp} — products matched`, value: s.matched },
      { metric: `${comp} — JJ cheaper`, value: `${s.cheaper} (${pct(s.cheaper, s.matched)})` },
      { metric: `${comp} — same price`, value: `${s.tied} (${pct(s.tied, s.matched)})` },
      { metric: `${comp} — JJ more expensive`, value: `${s.moreExpensive} (${pct(s.moreExpensive, s.matched)})` },
      { metric: `${comp} — avg JJ diff % (+ = JJ dearer)`, value: avg(s.diffPcts) },
      { metric: `${comp} — median JJ diff %`, value: median(s.diffPcts) },
    ]);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(__dirname, '..', 'reports', `rough-country-competitive-report-${timestamp}.xlsx`);
  await workbook.xlsx.writeFile(outPath);

  console.log(`Report written to ${outPath}`);
  console.log(`Products: ${overall.total}, with competitor data: ${overall.withCompetitorData}`);
  console.log(`Cheapest: ${overall.cheapestOverall}, tied: ${overall.tiedOverall}, more expensive: ${overall.moreExpensiveOverall}`);
  for (const comp of COMPETITORS) {
    const s = stats[comp];
    console.log(`${comp}: matched ${s.matched}, cheaper ${s.cheaper}, tied ${s.tied}, dearer ${s.moreExpensive}`);
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
