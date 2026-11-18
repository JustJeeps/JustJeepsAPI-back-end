#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');

dotenv.config();

const DEFAULT_CSV_PATH = 'pricing_update/cad_store/weekly check nov 17.csv';
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
    bulkSize: Number(process.env.MAGENTO_BULK_SIZE || 1000),
    waitMinutes: Number(process.env.MAGENTO_BULK_WAIT_MINUTES || 240),
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
    if (current === '--bulk-size' && next) {
      const value = Number(next);
      if (Number.isInteger(value) && value > 0) {
        args.bulkSize = value;
      }
      i++;
      continue;
    }
    if (current === '--wait-minutes' && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value >= 0) {
        args.waitMinutes = value;
      }
      i++;
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

// ---------------------------------------------------------------------------
// Async bulk attribute updates.
//
// One-at-a-time product saves get rate limited at the edge (Sucuri answers
// 429 to concurrent writes: 60% of a 53k-SKU run failed on 2026-11-17), and
// sequentially 53k saves take a day. The async bulk API takes thousands of
// updates in ONE request and Magento's queue consumers apply them server
// side, so the firewall only ever sees a handful of sequential POSTs.
//
// Two safeguards:
//  - the current values are read first (the same cheap paged GET the seeds
//    use) and only the SKUs whose value actually CHANGES are queued;
//  - a SKU the catalog does not know is never sent: POST /products CREATES a
//    product when the SKU does not exist, and a typo in the CSV must not
//    plant skeleton products in the live store.
// ---------------------------------------------------------------------------

const MAGENTO_REST_ROOT = MAGENTO_CONFIG.baseURL.replace(/\/V1\/?$/, '');
// Magento\Framework\Bulk\OperationInterface status codes.
const BULK_OP_COMPLETE = 1;
const BULK_OP_FAILED = [2, 3, 5]; // retriably failed, not retriably failed, rejected
const BULK_OP_OPEN = 4;

async function fetchCurrentAttributeValues() {
  const bySku = new Map();
  const pageSize = Number(process.env.MAGENTO_ATTR_PAGE_SIZE || 5000);
  const maxPages = Number(process.env.MAGENTO_ATTR_MAX_PAGES || 40);

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${MAGENTO_CONFIG.baseURL}/products?fields=items[sku,custom_attributes[${BLACK_FRIDAY_ATTRIBUTE_CODE}]]` +
      `&searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${page}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${MAGENTO_CONFIG.token}`, Accept: 'application/json' },
      timeout: Math.max(MAGENTO_CONFIG.timeout, 60000),
    });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    for (const item of items) {
      if (!item?.sku) continue;
      const attr = (item.custom_attributes || []).find(
        (a) => a.attribute_code === BLACK_FRIDAY_ATTRIBUTE_CODE
      );
      bySku.set(String(item.sku), attr ? String(attr.value) : '');
    }
    console.log(`   Current values page ${page}: ${items.length} products (total ${bySku.size})`);
    if (items.length < pageSize) break;
    await sleep(300);
  }

  return bySku;
}

async function submitAttributeBulk(rows) {
  const payload = rows.map((row) => ({
    product: {
      sku: row.sku,
      custom_attributes: [{ attribute_code: BLACK_FRIDAY_ATTRIBUTE_CODE, value: row.value }],
    },
  }));

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await axios.post(`${MAGENTO_REST_ROOT}/async/bulk/V1/products`, payload, {
        headers: {
          Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
          'Content-Type': 'application/json',
        },
        timeout: Math.max(MAGENTO_CONFIG.timeout, 120000),
      });
      return response.data?.bulk_uuid || null;
    } catch (error) {
      if (attempt <= 3 && shouldRetry(error)) {
        await sleep(error?.response?.status === 429 ? 5000 * attempt : 2000 * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error('unreachable');
}

async function getBulkOperations(uuid) {
  const response = await axios.get(`${MAGENTO_REST_ROOT}/V1/bulk/${uuid}/status`, {
    headers: { Authorization: `Bearer ${MAGENTO_CONFIG.token}`, Accept: 'application/json' },
    timeout: MAGENTO_CONFIG.timeout,
  });
  return Array.isArray(response.data?.operations_list) ? response.data.operations_list : [];
}

async function updateAttributesBulk(attributes, { bulkSize, waitMinutes }) {
  const failedRows = [];

  console.log('   Reading current attribute values from Magento (paged GET)...');
  const currentBySku = await fetchCurrentAttributeValues();

  const unknown = attributes.filter((row) => !currentBySku.has(row.sku));
  const unchanged = attributes.filter(
    (row) => currentBySku.has(row.sku) && currentBySku.get(row.sku) === String(row.value)
  );
  const delta = attributes.filter(
    (row) => currentBySku.has(row.sku) && currentBySku.get(row.sku) !== String(row.value)
  );

  console.log(`   Already at the target value (skipped): ${unchanged.length}`);
  console.log(`   Not found in Magento (skipped, never created): ${unknown.length}`);
  if (unknown.length) {
    console.log('   Sample unknown SKUs:', unknown.slice(0, 5).map((row) => row.sku));
    failedRows.push(...unknown.map((row) => ({ ...row, error: 'SKU not found in Magento' })));
  }
  console.log(`   To update: ${delta.length}`);

  if (!delta.length) return { updated: 0, skipped: unchanged.length, failedRows };

  // Queue the updates: a handful of sequential POSTs instead of one request
  // per SKU, which is exactly the shape the firewall tolerates.
  const bulks = [];
  const groups = chunk(delta, bulkSize);
  for (let i = 0; i < groups.length; i++) {
    const uuid = await submitAttributeBulk(groups[i]);
    bulks.push({ uuid, rows: groups[i] });
    console.log(`   Bulk ${i + 1}/${groups.length} queued (${groups[i].length} SKUs) | uuid ${uuid}`);
    await sleep(1000);
  }

  // Follow the queue until every operation leaves "open" or the deadline hits.
  const deadline = Date.now() + waitMinutes * 60 * 1000;
  let updated = 0;
  let pending = bulks.map((bulk) => ({ ...bulk, done: false }));

  while (pending.some((bulk) => !bulk.done)) {
    if (Date.now() > deadline) {
      const openRows = pending.filter((b) => !b.done).reduce((sum, b) => sum + b.rows.length, 0);
      console.log(`   ⚠️ Wait deadline (${waitMinutes} min) reached with ~${openRows} operations still queued; they keep processing on the server.`);
      break;
    }
    await sleep(Number(process.env.MAGENTO_BULK_POLL_MS || 30000));

    let complete = 0;
    let open = 0;
    for (const bulk of pending) {
      if (bulk.done) {
        complete += bulk.rows.length - bulk.failed;
        continue;
      }
      let operations = [];
      try {
        operations = await getBulkOperations(bulk.uuid);
      } catch (pollError) {
        open += bulk.rows.length;
        continue; // transient: poll again on the next pass
      }
      const openOps = operations.filter((op) => op.status === BULK_OP_OPEN).length;
      const failedOps = operations.filter((op) => BULK_OP_FAILED.includes(op.status));
      const completeOps = operations.filter((op) => op.status === BULK_OP_COMPLETE).length;
      complete += completeOps;
      open += openOps;
      if (openOps === 0) {
        bulk.done = true;
        bulk.failed = failedOps.length;
        for (const op of failedOps) {
          const row = bulk.rows[op.id] || {};
          failedRows.push({ ...row, error: String(op.result_message || `bulk operation status ${op.status}`) });
        }
      }
    }
    console.log(`   Bulk progress: ${complete} applied, ${open} queued, ${failedRows.length - unknown.length} failed (of ${delta.length})`);
    updated = complete;
  }

  return { updated, skipped: unchanged.length, failedRows };
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
  console.log(`- Bulk size (attributes): ${args.bulkSize}`);
  console.log(`- Bulk wait ceiling: ${args.waitMinutes} min`);
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
  let attributesSkipped = 0;

  if (updateAttrs && attributes.length) {
    console.log('');
    console.log(`Updating ${BLACK_FRIDAY_ATTRIBUTE_CODE} on ${attributes.length} SKUs (async bulk)...`);
    const result = await updateAttributesBulk(attributes, {
      bulkSize: args.bulkSize,
      waitMinutes: args.waitMinutes,
    });
    attributesUpdated = result.updated;
    attributesSkipped = result.skipped;
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
    console.log(`- Attribute rows already correct (skipped): ${attributesSkipped}`);
    console.log(`- Attribute rows updated: ${attributesUpdated}`);
    console.log(`- Attribute rows failed: ${attributesFailed}`);
    if (failedRows.length) {
      const samples = [...new Set(failedRows.map((row) => row.error))].slice(0, 5);
      console.log('- Sample failure reasons:', samples);
    }
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
