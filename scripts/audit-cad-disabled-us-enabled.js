#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

dotenv.config();

function resolveMagentoBaseUrl() {
  const candidates = [
    process.env.M2_BASE_URL_ROOT,
    process.env.MAGENTO_BASE_URL,
    process.env.M2_BASE_URL_DEFAULT,
    process.env.M2_BASE_URL,
  ].filter(Boolean);

  const rawBaseUrl = candidates[0] || 'https://www.justjeeps.com';
  return rawBaseUrl.replace(/\/rest\/.*$/i, '').replace(/\/$/, '');
}

const MAGENTO_CONFIG = {
  baseUrl: resolveMagentoBaseUrl(),
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 15000),
};

function parseArgs(argv) {
  const options = {
    skus: [],
    file: null,
    jjPrefix: null,
    brandName: null,
    limit: null,
    concurrency: 10,
    cadStoreCode: process.env.MAGENTO_CAD_STORE_CODE || 'default',
    usStoreCode: process.env.MAGENTO_US_STORE_CODE || 'us_sv',
    cadStatus: 2,
    usStatus: 1,
    output: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--sku' && argv[i + 1]) {
      options.skus.push(argv[++i]);
    } else if (arg === '--skus' && argv[i + 1]) {
      options.skus.push(...argv[++i].split(','));
    } else if (arg === '--file' && argv[i + 1]) {
      options.file = argv[++i];
    } else if ((arg === '--jj-prefix' || arg === '--prefix') && argv[i + 1]) {
      options.jjPrefix = argv[++i];
    } else if ((arg === '--brand' || arg === '--vendor') && argv[i + 1]) {
      options.brandName = argv[++i];
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--concurrency' && argv[i + 1]) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--cad-store-code' && argv[i + 1]) {
      options.cadStoreCode = argv[++i];
    } else if (arg === '--us-store-code' && argv[i + 1]) {
      options.usStoreCode = argv[++i];
    } else if (arg === '--cad-status' && argv[i + 1]) {
      options.cadStatus = Number(argv[++i]);
    } else if (arg === '--us-status' && argv[i + 1]) {
      options.usStatus = Number(argv[++i]);
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = argv[++i];
    }
  }

  options.skus = normalizeSkuList(options.skus);
  return options;
}

function normalizeSkuList(values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value || '').split(/[\n,]/))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function readSkusFromFile(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstLineColumns = lines[0].split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
  const skuIndex = firstLineColumns.findIndex((column) => column.toLowerCase() === 'sku');
  const dataLines = skuIndex >= 0 ? lines.slice(1) : lines;

  return normalizeSkuList(
    dataLines.map((line) => {
      const columns = line.split(',');
      return (columns[skuIndex >= 0 ? skuIndex : 0] || '').replace(/^"|"$/g, '');
    })
  );
}

async function getCandidateSkus(options) {
  const directSkus = normalizeSkuList([
    ...options.skus,
    ...(options.file ? readSkusFromFile(options.file) : []),
  ]);

  if (directSkus.length > 0) {
    return directSkus.slice(0, options.limit || directSkus.length);
  }

  const where = {};

  if (options.jjPrefix) {
    where.jj_prefix = {
      equals: options.jjPrefix,
      mode: 'insensitive',
    };
  }

  if (options.brandName) {
    where.brand_name = {
      equals: options.brandName,
      mode: 'insensitive',
    };
  }

  if (!options.jjPrefix && !options.brandName) {
    where.status = options.cadStatus;
  }

  const products = await prisma.product.findMany({
    where,
    select: { sku: true },
    orderBy: { sku: 'asc' },
    ...(options.limit ? { take: options.limit } : {}),
  });

  return products.map((product) => product.sku);
}

function buildMagentoRequestConfig() {
  return {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      Accept: 'application/json',
    },
    timeout: MAGENTO_CONFIG.timeout,
  };
}

async function fetchMagentoStatus(sku, storeCode) {
  const endpoint = `${MAGENTO_CONFIG.baseUrl.replace(/\/$/, '')}/rest/${storeCode}/V1/products/${encodeURIComponent(sku)}?fields=sku,status`;

  try {
    const response = await axios.get(endpoint, buildMagentoRequestConfig());
    return {
      success: true,
      status: Number(response.data?.status),
      statusCode: response.status,
    };
  } catch (error) {
    return {
      success: false,
      status: null,
      statusCode: error.response?.status || null,
      error: error.response?.data?.message || error.response?.data || error.message,
    };
  }
}

async function auditSku(sku, options) {
  const [cadResult, usResult] = await Promise.all([
    fetchMagentoStatus(sku, options.cadStoreCode),
    fetchMagentoStatus(sku, options.usStoreCode),
  ]);

  return {
    sku,
    cad_store_code: options.cadStoreCode,
    cad_status: cadResult.status,
    cad_success: cadResult.success,
    cad_error: cadResult.success ? '' : formatError(cadResult.error),
    us_store_code: options.usStoreCode,
    us_status: usResult.status,
    us_success: usResult.success,
    us_error: usResult.success ? '' : formatError(usResult.error),
    is_cad_disabled_us_enabled: cadResult.status === options.cadStatus && usResult.status === options.usStatus,
  };
}

function formatError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

async function processInChunks(skus, options) {
  const rows = [];

  for (let i = 0; i < skus.length; i += options.concurrency) {
    const chunk = skus.slice(i, i + options.concurrency);
    console.log(`Checking ${i + 1}-${i + chunk.length} of ${skus.length}`);
    const chunkRows = await Promise.all(chunk.map((sku) => auditSku(sku, options)));
    rows.push(...chunkRows);
  }

  return rows;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeCsv(rows, outputPath) {
  const header = [
    'sku',
    'cad_store_code',
    'cad_status',
    'cad_success',
    'cad_error',
    'us_store_code',
    'us_status',
    'us_success',
    'us_error',
    'is_cad_disabled_us_enabled',
  ];

  const csv = [
    header.join(','),
    ...rows.map((row) => header.map((key) => csvEscape(row[key])).join(',')),
  ].join('\n');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv);
}

function buildOutputPath(customOutputPath) {
  if (customOutputPath) {
    return path.resolve(process.cwd(), customOutputPath);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(__dirname, '..', 'reports', `cad-disabled-us-enabled-status-audit-${timestamp}.csv`);
}

function printUsage() {
  console.log('Audit Magento SKUs where CAD/default store is disabled but US store is enabled.');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/audit-cad-disabled-us-enabled.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --sku <sku>               Check one SKU. Can be repeated.');
  console.log('  --skus <a,b,c>            Check comma-separated SKUs.');
  console.log('  --file <path>             Read SKUs from a text/CSV file. Uses sku column if present, else first column.');
  console.log('  --jj-prefix <code>        Load candidate SKUs from Product.jj_prefix.');
  console.log('  --brand <name>            Load candidate SKUs from Product.brand_name.');
  console.log('  --limit <number>          Limit candidate SKUs.');
  console.log('  --concurrency <number>    Concurrent SKU checks (default: 10).');
  console.log('  --cad-store-code <code>   Magento CAD store code (default: default).');
  console.log('  --us-store-code <code>    Magento US store code (default: us_sv).');
  console.log('  --cad-status <number>     CAD status to flag (default: 2).');
  console.log('  --us-status <number>      US status to flag (default: 1).');
  console.log('  --output <path>           CSV output path.');
  console.log('');
  console.log('If no SKU, file, prefix, or brand is provided, candidates default to local Product.status = 2.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);

  if (!MAGENTO_CONFIG.token) {
    throw new Error('MAGENTO_KEY is required in environment variables');
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Invalid --concurrency. Expected integer >= 1.');
  }

  if (!Number.isInteger(options.cadStatus) || !Number.isInteger(options.usStatus)) {
    throw new Error('Invalid status value. Expected integer Magento status codes.');
  }

  const skus = await getCandidateSkus(options);
  console.log(`Candidate SKUs: ${skus.length}`);

  if (skus.length === 0) {
    console.log('No SKUs found. Nothing to audit.');
    return;
  }

  console.log(`CAD store code: ${options.cadStoreCode}; flag status: ${options.cadStatus}`);
  console.log(`US store code: ${options.usStoreCode}; flag status: ${options.usStatus}`);

  const rows = await processInChunks(skus, options);
  const mismatches = rows.filter((row) => row.is_cad_disabled_us_enabled);
  const failures = rows.filter((row) => !row.cad_success || !row.us_success);
  const outputPath = buildOutputPath(options.output);

  writeCsv(rows, outputPath);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        checked_count: rows.length,
        cad_disabled_us_enabled_count: mismatches.length,
        api_failure_count: failures.length,
        sample_matches: mismatches.slice(0, 20).map((row) => row.sku),
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });