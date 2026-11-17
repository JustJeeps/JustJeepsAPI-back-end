#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');

dotenv.config();

const DEFAULT_CSV_PATH = 'pricing_update/cad_store/weekly check nov9.csv';
const DEFAULT_BATCH_SIZE = 500;
const CAD_STORE_ID = Number(process.env.CAD_STORE_ID || 0);
const CAD_STORE_ID_MIRROR = Number(process.env.CAD_STORE_ID_MIRROR || 1);

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL_DEFAULT || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 20000),
};

const BLACK_FRIDAY_ATTRIBUTE_CODE =
  process.env.MAGENTO_BF_ATTRIBUTE_CODE || 'black_friday_sale_attribute';

// CSV black_friday_sale value -> Magento attribute option ID
const BLACK_FRIDAY_OPTION_IDS = {
  no_sale: process.env.MAGENTO_BF_NO_SALE_OPTION_ID || '4589',
  sale_20: process.env.MAGENTO_BF_SALE_20_OPTION_ID || '4556',
  sale_25: process.env.MAGENTO_BF_SALE_25_OPTION_ID || '4557',
  sale_30: process.env.MAGENTO_BF_SALE_30_OPTION_ID || '4558',
};

function parseArgs(argv) {
  const args = {
    file: DEFAULT_CSV_PATH,
    live: false,
    noMirror: false,
    batchSize: DEFAULT_BATCH_SIZE,
    report: '',
    attributes: false,
    attributesOnly: false,
    concurrency: 10,
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
    if (current === '--concurrency' && next) {
      const value = Number(next);
      if (Number.isInteger(value) && value > 0) {
        args.concurrency = value;
      }
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
    if (current === '--attributes') {
      args.attributes = true;
      continue;
    }
    if (current === '--attributes-only') {
      args.attributesOnly = true;
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

function toAttributeRows(csvRows) {
  const attributes = [];
  const invalidRows = [];
  const seen = new Set();

  for (const row of csvRows) {
    const sku = String(row.sku || '').trim();
    const saleValue = String(row.black_friday_sale || '').trim().toLowerCase();

    if (!sku || seen.has(sku)) continue;

    const optionId = BLACK_FRIDAY_OPTION_IDS[saleValue];
    if (!optionId) {
      invalidRows.push({ sku, black_friday_sale: row.black_friday_sale });
      continue;
    }

    seen.add(sku);
    attributes.push({ sku, black_friday_sale: saleValue, value: optionId });
  }

  return { attributes, invalidRows };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  const status = error?.response?.status;
  const code = error?.code;

  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  if (String(error?.message || '').includes('ETIMEDOUT')) return true;
  if (String(error?.message || '').includes('timeout')) return true;

  return false;
}

async function putBlackFridayAttribute(sku, optionId) {
  const url = `${MAGENTO_CONFIG.baseURL}/products/${encodeURIComponent(sku)}`;
  return axios.put(
    url,
    {
      product: {
        sku,
        custom_attributes: [
          { attribute_code: BLACK_FRIDAY_ATTRIBUTE_CODE, value: optionId },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      timeout: MAGENTO_CONFIG.timeout,
    }
  );
}

async function putBlackFridayAttributeWithRetry(sku, optionId, retries = 3, retryDelayMs = 2000) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await putBlackFridayAttribute(sku, optionId);
    } catch (error) {
      if (attempt <= retries && shouldRetry(error)) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error('unreachable');
}

async function updateAttributes(attributes, concurrency, chunkDelayMs = 500) {
  let updated = 0;
  const failedRows = [];
  const groups = chunk(attributes, concurrency);
  let consecutiveFailedGroups = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const results = await Promise.allSettled(
      group.map((row) => putBlackFridayAttributeWithRetry(row.sku, row.value))
    );

    let groupFailures = 0;
    results.forEach((result, idx) => {
      const row = group[idx];
      if (result.status === 'fulfilled') {
        updated += 1;
      } else {
        groupFailures += 1;
        const error = result.reason;
        const msg = String(error?.response?.data?.message || error?.message || 'unknown error');
        failedRows.push({
          sku: row.sku,
          black_friday_sale: row.black_friday_sale,
          value: row.value,
          error: msg,
        });
      }
    });

    consecutiveFailedGroups = groupFailures === group.length ? consecutiveFailedGroups + 1 : 0;

    // Circuit breaker: stop hammering the server if everything is failing (e.g. firewall block)
    if (consecutiveFailedGroups >= 5) {
      console.log(
        `🛑 Aborting: ${consecutiveFailedGroups} consecutive chunks failed entirely. ` +
          'Server is likely rate limiting / blocking this IP. Wait a few minutes and rerun.'
      );
      break;
    }

    const processed = Math.min((i + 1) * concurrency, attributes.length);
    if ((i + 1) % 10 === 0 || i === groups.length - 1) {
      console.log(
        `   Attribute progress: ${processed}/${attributes.length} (updated: ${updated}, failed: ${failedRows.length})`
      );
    }

    if (chunkDelayMs > 0 && i < groups.length - 1) {
      await sleep(chunkDelayMs);
    }
  }

  return { updated, failedRows };
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

  const header = 'type,sku,price,store_id,black_friday_sale,error\n';
  const body = rows
    .map((row) => {
      const err = String(row.error || '').replace(/\n/g, ' ').replace(/,/g, ';');
      return `${row.type || 'price'},${row.sku},${row.price ?? ''},${row.store_id ?? ''},${row.black_friday_sale ?? ''},${err}`;
    })
    .join('\n');

  fs.writeFileSync(absoluteReport, header + body + (rows.length ? '\n' : ''), 'utf8');
  console.log(`📝 Failure report written: ${absoluteReport}`);
}

async function main() {
  const args = parseArgs(process.argv);

  const updatePrices = !args.attributesOnly;
  const updateAttrs = args.attributes || args.attributesOnly;

  console.log('Update Magento CAD store prices + black friday attribute from CSV');
  console.log(`- File: ${args.file}`);
  console.log(`- Mode: ${args.live ? 'LIVE' : 'DRY RUN'}`);
  console.log(`- Update prices: ${updatePrices ? 'ON' : 'OFF'}`);
  console.log(`- Update ${BLACK_FRIDAY_ATTRIBUTE_CODE}: ${updateAttrs ? 'ON' : 'OFF'}`);
  console.log(`- Batch size (prices): ${args.batchSize}`);
  console.log(`- Concurrency (attributes): ${args.concurrency}`);
  console.log(`- Mirror CAD -> store_id ${CAD_STORE_ID_MIRROR}: ${args.noMirror ? 'OFF' : 'ON'}`);

  if (args.live && !MAGENTO_CONFIG.token) {
    throw new Error('Missing MAGENTO_KEY env var for live updates.');
  }

  const { absolutePath, rows } = parseCsvRows(args.file);
  const { prices, invalidRows } = updatePrices
    ? toPriceRows(rows, args.noMirror)
    : { prices: [], invalidRows: [] };
  const { attributes, invalidRows: invalidAttributeRows } = updateAttrs
    ? toAttributeRows(rows)
    : { attributes: [], invalidRows: [] };

  console.log(`- CSV absolute path: ${absolutePath}`);
  console.log(`- Input rows: ${rows.length}`);
  if (updatePrices) {
    console.log(`- Valid price rows to send: ${prices.length}`);
    console.log(`- Invalid price rows skipped: ${invalidRows.length}`);
  }
  if (updateAttrs) {
    console.log(`- Valid attribute rows to send: ${attributes.length}`);
    console.log(`- Invalid attribute rows skipped: ${invalidAttributeRows.length}`);
  }

  if (invalidRows.length > 0) {
    console.log('⚠️ Sample invalid price rows (up to 10):', invalidRows.slice(0, 10));
  }
  if (invalidAttributeRows.length > 0) {
    console.log('⚠️ Sample invalid attribute rows (up to 10):', invalidAttributeRows.slice(0, 10));
  }

  if (!prices.length && !attributes.length) {
    console.log('No valid rows to process. Exiting.');
    return;
  }

  if (!args.live) {
    if (updatePrices) {
      console.log('DRY RUN sample price payload rows (first 20):');
      console.log(prices.slice(0, 20));
    }
    if (updateAttrs) {
      console.log(`DRY RUN sample ${BLACK_FRIDAY_ATTRIBUTE_CODE} rows (first 20):`);
      console.log(attributes.slice(0, 20));
    }
    return;
  }

  const failedRows = [];
  let batches = [];
  let sentRows = 0;
  let sentBatches = 0;

  if (updatePrices) {
    batches = chunk(prices, args.batchSize);

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
          ...batch.map((row) => ({ ...row, type: 'price', error: msg }))
        );
      }
    }
  }

  let attributesUpdated = 0;
  let attributesFailed = 0;

  if (updateAttrs && attributes.length) {
    console.log('');
    console.log(`Updating ${BLACK_FRIDAY_ATTRIBUTE_CODE} on ${attributes.length} SKUs...`);
    const result = await updateAttributes(attributes, args.concurrency);
    attributesUpdated = result.updated;
    attributesFailed = result.failedRows.length;
    failedRows.push(
      ...result.failedRows.map((row) => ({ ...row, type: 'attribute' }))
    );
  }

  console.log('');
  console.log('Summary');
  if (updatePrices) {
    console.log(`- Price batches total: ${batches.length}`);
    console.log(`- Price batches sent: ${sentBatches}`);
    console.log(`- Price rows attempted: ${prices.length}`);
    console.log(`- Price rows sent: ${sentRows}`);
  }
  if (updateAttrs) {
    console.log(`- Attribute rows attempted: ${attributes.length}`);
    console.log(`- Attribute rows updated: ${attributesUpdated}`);
    console.log(`- Attribute rows failed: ${attributesFailed}`);
  }
  console.log(`- Total rows failed: ${failedRows.length}`);

  if (args.report) {
    writeFailureReport(args.report, failedRows);
  }
}

main().catch((error) => {
  console.error('❌ CSV update failed:', error.message || error);
  process.exitCode = 1;
});
