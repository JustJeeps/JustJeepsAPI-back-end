#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');

dotenv.config();

const DEFAULT_CSV_PATH = 'pricing_update/cad_store/weekly check june16.csv';
const DEFAULT_BATCH_SIZE = 500;
const CAD_STORE_ID = Number(process.env.CAD_STORE_ID || 0);
const CAD_STORE_ID_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 20000),
};

function parseArgs(argv) {
  const args = {
    file: DEFAULT_CSV_PATH,
    live: false,
    noMirror: false,
    batchSize: DEFAULT_BATCH_SIZE,
    report: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === '--file' && next) {
      args.file = next;
      i++;
      continue;
    }
    if (current === '--batch-size' && next) {
      const value = Number(next);
      if (Number.isInteger(value) && value > 0) {
        args.batchSize = value;
      }
      i++;
      continue;
    }
    if (current === '--report' && next) {
      args.report = next;
      i++;
      continue;
    }
    if (current === '--live') {
      args.live = true;
      continue;
    }
    if (current === '--no-mirror') {
      args.noMirror = true;
      continue;
    }
  }

  return args;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function resolveStoreId(storeViewCode) {
  const raw = String(storeViewCode || '').trim().toLowerCase();
  if (!raw || raw === 'default' || raw === 'all') return CAD_STORE_ID;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'us_sv') return 1;
  return null;
}

function parseCsvRows(filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  const csvText = fs.readFileSync(absolutePath, 'utf8');
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  return { absolutePath, rows };
}

function toPriceRows(csvRows, noMirror = false) {
  const prices = [];
  const invalidRows = [];

  for (const row of csvRows) {
    const sku = String(row.sku || '').trim();
    const price = Number(row.price);
    const storeId = resolveStoreId(row.store_view_code);

    if (!sku || !Number.isFinite(price) || price < 0 || storeId == null) {
      invalidRows.push({
        sku,
        price: row.price,
        store_view_code: row.store_view_code,
      });
      continue;
    }

    const roundedPrice = Number(price.toFixed(2));
    prices.push({ sku, price: roundedPrice, store_id: storeId });

    if (!noMirror && storeId === CAD_STORE_ID && CAD_STORE_ID_MIRROR !== CAD_STORE_ID) {
      prices.push({ sku, price: roundedPrice, store_id: CAD_STORE_ID_MIRROR });
    }
  }

  return { prices, invalidRows };
}

async function postBasePricesBatch(prices) {
  const response = await axios.post(
    `${MAGENTO_CONFIG.baseURL}/products/base-prices`,
    { prices },
    {
      headers: {
        Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      timeout: MAGENTO_CONFIG.timeout,
    }
  );
  return response;
}

function writeFailureReport(reportPath, rows) {
  if (!reportPath || !rows.length) return;

  const absoluteReport = path.isAbsolute(reportPath)
    ? reportPath
    : path.join(process.cwd(), reportPath);

  const dir = path.dirname(absoluteReport);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const header = 'sku,price,store_id,error\n';
  const body = rows
    .map((row) => {
      const err = String(row.error || '').replace(/\n/g, ' ').replace(/,/g, ';');
      return `${row.sku},${row.price},${row.store_id},${err}`;
    })
    .join('\n');

  fs.writeFileSync(absoluteReport, header + body + (rows.length ? '\n' : ''), 'utf8');
  console.log(`📝 Failure report written: ${absoluteReport}`);
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('Update Magento CAD store prices from CSV');
  console.log(`- File: ${args.file}`);
  console.log(`- Mode: ${args.live ? 'LIVE' : 'DRY RUN'}`);
  console.log(`- Batch size: ${args.batchSize}`);
  console.log(`- Mirror CAD -> store_id ${CAD_STORE_ID_MIRROR}: ${args.noMirror ? 'OFF' : 'ON'}`);

  if (args.live && !MAGENTO_CONFIG.token) {
    throw new Error('Missing MAGENTO_KEY env var for live updates.');
  }

  const { absolutePath, rows } = parseCsvRows(args.file);
  const { prices, invalidRows } = toPriceRows(rows, args.noMirror);

  console.log(`- CSV absolute path: ${absolutePath}`);
  console.log(`- Input rows: ${rows.length}`);
  console.log(`- Valid price rows to send: ${prices.length}`);
  console.log(`- Invalid rows skipped: ${invalidRows.length}`);

  if (invalidRows.length > 0) {
    console.log('⚠️ Sample invalid rows (up to 10):', invalidRows.slice(0, 10));
  }

  if (!prices.length) {
    console.log('No valid rows to process. Exiting.');
    return;
  }

  if (!args.live) {
    console.log('DRY RUN sample payload rows (first 20):');
    console.log(prices.slice(0, 20));
    return;
  }

  const batches = chunk(prices, args.batchSize);
  let sentRows = 0;
  let sentBatches = 0;
  const failedRows = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const res = await postBasePricesBatch(batch);
      sentRows += batch.length;
      sentBatches += 1;
      console.log(`✅ Batch ${i + 1}/${batches.length} sent (${batch.length} rows) | HTTP ${res.status}`);
    } catch (error) {
      const msg = String(error.response?.data?.message || error.message || 'unknown error');
      console.log(`❌ Batch ${i + 1}/${batches.length} failed (${batch.length} rows): ${msg}`);
      failedRows.push(
        ...batch.map((row) => ({ ...row, error: msg }))
      );
    }
  }

  console.log('');
  console.log('Summary');
  console.log(`- Batches total: ${batches.length}`);
  console.log(`- Batches sent: ${sentBatches}`);
  console.log(`- Rows attempted: ${prices.length}`);
  console.log(`- Rows sent: ${sentRows}`);
  console.log(`- Rows failed: ${failedRows.length}`);

  if (args.report) {
    writeFailureReport(args.report, failedRows);
  }
}

main().catch((error) => {
  console.error('❌ CSV price update failed:', error.message || error);
  process.exitCode = 1;
});
