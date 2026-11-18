#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');

const {
  dedupePriceRows,
  diffPriceRows,
  collectBasePriceErrors,
  publishExitCode,
  readCustomAttribute,
} = require('../../lib/magento/cadStorePublish');

dotenv.config();

const DEFAULT_CSV_PATH = 'pricing_update/cad_store/weekly check nov 17.csv';
const DEFAULT_BATCH_SIZE = 500;
const PRICE_LOOKUP_BATCH_SIZE = 500;
const PRICE_BATCH_DELAY_MS = Number(process.env.MAGENTO_PRICE_BATCH_DELAY_MS || 300);
// Written on every live run: on 2026-11-17 13,301 rows failed and the reason
// of none of them survived, because the report only existed with --report.
const DEFAULT_REPORT_PATH = 'logs/cad-store-publish-failures.csv';
const UNKNOWN_SKU_ERROR = 'SKU not found in Magento';
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
    // The queue is applied on Magento's side whether we watch it or not, and
    // this process holds the panel's run slot while it waits.
    waitMinutes: Number(process.env.MAGENTO_BULK_WAIT_MINUTES || 20),
    limit: null,
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
    if (current === '--limit') {
      // No silent fallback here: a mistyped limit must never turn a "try it
      // on a few rows" run into a publish of the whole file.
      const value = Number(next);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --limit "${next ?? ''}": expected a positive integer.`);
      }
      args.limit = value;
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
      bySku.set(String(item.sku), readCustomAttribute(item, BLACK_FRIDAY_ATTRIBUTE_CODE));
    }
    console.log(`   Current values page ${page}: ${items.length} products (total ${bySku.size})`);
    if (items.length < pageSize) return bySku;
    await sleep(300);
  }

  // Reaching the cap means the catalog was NOT read to the end: carrying on
  // would report every unread SKU as "not found in Magento".
  throw new Error(
    `Catalog read stopped at the ${maxPages}-page cap (${bySku.size} products); raise MAGENTO_ATTR_MAX_PAGES.`
  );
}

// One retry policy for every write and lookup: 429 backs off longer because
// the firewall needs a real cool-down.
async function withMagentoRetry(request, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (attempt > retries || !shouldRetry(error)) throw error;
      await sleep(error?.response?.status === 429 ? 5000 * attempt : 2000 * attempt);
    }
  }
}

// sku -> store_id -> price, read in batches. A batch that cannot be read is
// left out of the map, so its rows are sent rather than assumed unchanged.
async function fetchCurrentBasePrices(skus) {
  const bySku = new Map();
  let failedBatches = 0;
  const batches = chunk([...new Set(skus)], PRICE_LOOKUP_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    try {
      const response = await withMagentoRetry(() =>
        axios.post(
          `${MAGENTO_CONFIG.baseURL}/products/base-prices-information`,
          { skus: batches[i] },
          {
            headers: {
              Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
              'Content-Type': 'application/json',
            },
            timeout: Math.max(MAGENTO_CONFIG.timeout, 60000),
          }
        )
      );
      for (const item of Array.isArray(response.data) ? response.data : []) {
        const sku = String(item?.sku || '').trim();
        const storeId = Number(item?.store_id);
        const price = Number(item?.price);
        if (!sku || !Number.isInteger(storeId) || !Number.isFinite(price)) continue;
        if (!bySku.has(sku)) bySku.set(sku, new Map());
        bySku.get(sku).set(storeId, price);
      }
    } catch (error) {
      failedBatches += 1;
      console.log(
        `   ⚠️ Price lookup ${i + 1}/${batches.length} failed (${error.response?.status || error.code || 'ERR'}); its rows will be sent without comparing.`
      );
    }
    if ((i + 1) % 20 === 0 || i === batches.length - 1) {
      console.log(`   Current prices read: ${i + 1}/${batches.length} lookups`);
    }
    await sleep(PRICE_BATCH_DELAY_MS);
  }

  return { bySku, failedBatches };
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
    failedRows.push(...unknown.map((row) => ({ ...row, error: UNKNOWN_SKU_ERROR, skipped: true })));
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
      console.log('   Bulks still open (check with GET /V1/bulk/<uuid>/status):', pending.filter((b) => !b.done).map((b) => b.uuid));
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
  if (!reportPath) return;

  const absoluteReport = path.isAbsolute(reportPath)
    ? reportPath
    : path.join(process.cwd(), reportPath);

  if (!rows.length) {
    // The path is fixed, so a clean run must not leave the previous run's
    // failures behind looking like its own.
    if (fs.existsSync(absoluteReport)) fs.rmSync(absoluteReport);
    return;
  }

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

  const { absolutePath, rows: allRows } = parseCsvRows(args.file);
  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;
  if (args.limit) console.log(`- Limit: first ${rows.length} of ${allRows.length} CSV rows`);
  const { prices: rawPrices, invalidRows } = updatePrices
    ? toPriceRows(rows, args.noMirror)
    : { prices: [], invalidRows: [] };
  const { rows: prices, duplicates: duplicatePrices } = dedupePriceRows(rawPrices);
  if (duplicatePrices.length) {
    console.log(`⚠️ Duplicate price rows ignored (first one kept): ${duplicatePrices.length}`);
    console.log('   Sample:', duplicatePrices.slice(0, 5));
  }
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
  let pricesUnchanged = 0;
  const loggedPriceErrors = new Set();

  if (updatePrices) {
    console.log('');
    console.log('Reading current prices from Magento to send only what changes...');
    const { bySku: currentPrices, failedBatches: failedLookups } = await fetchCurrentBasePrices(
      prices.map((row) => row.sku)
    );
    const { changed: pricesToSend, unchanged, unknown: unknownPrices } = diffPriceRows(
      prices,
      currentPrices,
      { lookupComplete: failedLookups === 0 }
    );
    pricesUnchanged = unchanged.length;
    console.log(`   Already at the target price (skipped): ${pricesUnchanged}`);
    if (unknownPrices.length) {
      console.log(`   Not found in Magento (skipped): ${unknownPrices.length} rows`);
      console.log('   Sample unknown SKUs:', [...new Set(unknownPrices.map((row) => row.sku))].slice(0, 5));
      failedRows.push(
        ...unknownPrices.map((row) => ({ ...row, type: 'price', error: UNKNOWN_SKU_ERROR, skipped: true }))
      );
    }
    console.log(`   To update: ${pricesToSend.length}${failedLookups ? ` (${failedLookups} lookups failed, their rows are included)` : ''}`);

    batches = chunk(pricesToSend, args.batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        const res = await withMagentoRetry(() => postBasePricesBatch(batch));
        // HTTP 200 is not "applied": the body lists the rows Magento rejected.
        const rejected = collectBasePriceErrors(res.data, batch);
        // One row can be rejected for more than one reason: count rows.
        const rejectedSkus = new Set(rejected.map((row) => row.sku));
        const rejectedRowCount = rejectedSkus.has('')
          ? Math.min(batch.length, rejected.length)
          : batch.filter((row) => rejectedSkus.has(row.sku)).length;
        sentRows += batch.length - rejectedRowCount;
        sentBatches += 1;
        failedRows.push(...rejected.map((row) => ({ ...row, type: 'price' })));
        for (const row of rejected) {
          const reason = row.error.replace(/\[[^\]]*\]$/, '').trim();
          if (loggedPriceErrors.has(reason) || loggedPriceErrors.size >= 10) continue;
          loggedPriceErrors.add(reason);
          console.log(`   ⚠️ New rejection reason: ${row.error}`);
        }
        console.log(
          `${rejected.length ? '⚠️' : '✅'} Batch ${i + 1}/${batches.length} sent (${batch.length} rows, ${rejected.length} rejected) | HTTP ${res.status}`
        );
        if (i < batches.length - 1) await sleep(PRICE_BATCH_DELAY_MS);
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
    console.log(`- Price rows in the file: ${prices.length}`);
    console.log(`- Price rows already correct (skipped): ${pricesUnchanged}`);
    console.log(`- Price rows accepted: ${sentRows}`);
    console.log(`- Price errors reported: ${failedRows.filter((row) => row.type === 'price' && !row.skipped).length}`);
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

  try {
    writeFailureReport(args.report || DEFAULT_REPORT_PATH, failedRows);
  } catch (reportError) {
    // The publish already happened: a report that cannot be written must not
    // be what marks the run as failed.
    console.log(`⚠️ Could not write the failure report: ${reportError.message}`);
  }

  // A failed row must not end as "success": the panel records the exit code,
  // and the catalog sync chained after this must not run over a partial publish.
  process.exitCode = publishExitCode(failedRows);
  if (process.exitCode) {
    console.log('❌ Finished with failed rows; see the failure report above.');
  }
}

main().catch((error) => {
  console.error('❌ CSV update failed:', error.message || error);
  process.exitCode = 1;
});
