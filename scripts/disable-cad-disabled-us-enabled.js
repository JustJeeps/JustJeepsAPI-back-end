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
    file: null,
    status: 2,
    concurrency: 15,
    limit: null,
    dryRun: false,
    output: null,
    excludeSkus: normalizeSkuList((process.env.CAD_DISABLED_US_ENABLED_EXCLUDE_SKUS || '').split(',')),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--file' && argv[i + 1]) {
      options.file = argv[++i];
    } else if (arg === '--status' && argv[i + 1]) {
      options.status = Number(argv[++i]);
    } else if (arg === '--concurrency' && argv[i + 1]) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = argv[++i];
    } else if (arg === '--exclude-sku' && argv[i + 1]) {
      options.excludeSkus.push(argv[++i]);
    } else if (arg === '--exclude-skus' && argv[i + 1]) {
      options.excludeSkus.push(...argv[++i].split(','));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  options.excludeSkus = normalizeSkuList(options.excludeSkus);
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

function filterExcludedSkus(skus, excludeSkus) {
  const excluded = new Set(excludeSkus.map((sku) => sku.toUpperCase()));
  if (excluded.size === 0) return skus;
  return skus.filter((sku) => !excluded.has(String(sku).toUpperCase()));
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((column) => column.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return header.reduce((row, key, index) => {
      row[key] = values[index] ?? '';
      return row;
    }, {});
  });
}

function findLatestAuditReport() {
  const reportsDir = path.join(__dirname, '..', 'reports');
  const files = fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir)
      .filter((file) => /^cad-disabled-us-enabled-status-audit-.*\.csv$/.test(file))
      .map((file) => path.join(reportsDir, file))
    : [];

  if (files.length === 0) {
    throw new Error('No cad-disabled-us-enabled audit report found. Pass --file <path>.');
  }

  return files
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file;
}

function readConfirmedSkus(filePath, limit, excludeSkus) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const rows = parseCsv(fs.readFileSync(resolvedPath, 'utf8'));
  const skus = filterExcludedSkus(rows
    .filter((row) => row.is_cad_disabled_us_enabled === 'true')
    .filter((row) => row.cad_success === 'true' && row.us_success === 'true')
    .map((row) => String(row.sku || '').trim())
    .filter(Boolean), excludeSkus);

  const uniqueSkus = Array.from(new Set(skus));
  return limit ? uniqueSkus.slice(0, limit) : uniqueSkus;
}

function buildMagentoRequestConfig() {
  return {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: MAGENTO_CONFIG.timeout,
  };
}

async function discoverStoreViewCodes() {
  const endpoint = `${MAGENTO_CONFIG.baseUrl}/rest/V1/store/storeViews`;

  try {
    const response = await axios.get(endpoint, buildMagentoRequestConfig());
    const discoveredCodes = Array.isArray(response.data)
      ? response.data
        .map((view) => String(view?.code || '').trim())
        .filter((code) => code && code.toLowerCase() !== 'admin')
      : [];

    return Array.from(new Set(['all', ...discoveredCodes, 'default', 'us_sv']));
  } catch (error) {
    console.warn(`Failed to discover store views; using all/default/us_sv fallback: ${error.message}`);
    return ['all', 'default', 'us_sv'];
  }
}

async function setMagentoProductStatusByStoreView({ sku, status, storeViewCode }) {
  const endpoint = `${MAGENTO_CONFIG.baseUrl}/rest/${storeViewCode}/V1/products/${encodeURIComponent(sku)}`;
  const payload = { product: { status } };
  const requestConfig = buildMagentoRequestConfig();

  try {
    const response = await axios.put(endpoint, payload, requestConfig);
    return { storeViewCode, success: true, method: 'PUT', statusCode: response.status, error: '' };
  } catch (putError) {
    if (putError.response?.status === 405) {
      try {
        const response = await axios.post(endpoint, payload, requestConfig);
        return { storeViewCode, success: true, method: 'POST', statusCode: response.status, error: '' };
      } catch (postError) {
        return formatMagentoFailure(storeViewCode, postError);
      }
    }

    return formatMagentoFailure(storeViewCode, putError);
  }
}

function formatMagentoFailure(storeViewCode, error) {
  return {
    storeViewCode,
    success: false,
    method: '',
    statusCode: error.response?.status || null,
    error: formatError(error.response?.data || error.message),
  };
}

function formatError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

async function disableSkuAcrossStoreViews(sku, options, storeViewCodes) {
  if (options.dryRun) {
    return {
      sku,
      success: true,
      updatedStoreViews: [],
      failedStoreViews: [],
      results: storeViewCodes.map((storeViewCode) => ({
        storeViewCode,
        success: true,
        method: 'DRY_RUN',
        statusCode: '',
        error: '',
      })),
    };
  }

  const results = await Promise.all(
    storeViewCodes.map((storeViewCode) =>
      setMagentoProductStatusByStoreView({
        sku,
        status: options.status,
        storeViewCode,
      })
    )
  );

  const failedStoreViews = results.filter((result) => !result.success);
  const updatedStoreViews = results.filter((result) => result.success).map((result) => result.storeViewCode);

  if (updatedStoreViews.length > 0) {
    await prisma.product.updateMany({
      where: { sku },
      data: { status: options.status },
    });
  }

  return {
    sku,
    success: failedStoreViews.length === 0,
    updatedStoreViews,
    failedStoreViews,
    results,
  };
}

async function processInChunks(skus, options, storeViewCodes) {
  const rows = [];

  for (let i = 0; i < skus.length; i += options.concurrency) {
    const chunk = skus.slice(i, i + options.concurrency);
    console.log(`${options.dryRun ? 'Would disable' : 'Disabling'} ${i + 1}-${i + chunk.length} of ${skus.length}`);
    const results = await Promise.all(
      chunk.map((sku) => disableSkuAcrossStoreViews(sku, options, storeViewCodes))
    );
    rows.push(...results);
  }

  return rows;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeResultsCsv(rows, outputPath) {
  const header = [
    'sku',
    'success',
    'updated_store_views',
    'failed_store_views',
    'store_view_results',
  ];

  const csvRows = rows.map((row) => ({
    sku: row.sku,
    success: row.success,
    updated_store_views: row.updatedStoreViews.join('|'),
    failed_store_views: row.failedStoreViews.map((entry) => entry.storeViewCode).join('|'),
    store_view_results: JSON.stringify(row.results),
  }));

  const csv = [
    header.join(','),
    ...csvRows.map((row) => header.map((key) => csvEscape(row[key])).join(',')),
  ].join('\n');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv);
}

function buildOutputPath(customOutputPath, dryRun) {
  if (customOutputPath) {
    return path.resolve(process.cwd(), customOutputPath);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = dryRun ? 'dry-run' : 'live';
  return path.join(__dirname, '..', 'reports', `cad-disabled-us-enabled-disable-${suffix}-${timestamp}.csv`);
}

function printUsage() {
  console.log('Disable confirmed CAD-disabled / US-enabled SKUs across all Magento store views.');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/disable-cad-disabled-us-enabled.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file <path>             Audit CSV. Defaults to latest cad-disabled-us-enabled audit report.');
  console.log('  --status <number>         Magento status to set (default: 2).');
  console.log('  --concurrency <number>    Concurrent SKU updates (default: 15).');
  console.log('  --limit <number>          Limit matching SKUs. Useful for testing.');
  console.log('  --output <path>           Result CSV output path.');
  console.log('  --exclude-sku <sku>       Exclude one SKU. Can be repeated.');
  console.log('  --exclude-skus <a,b,c>    Exclude comma-separated SKUs.');
  console.log('  --dry-run                 Print/write intended changes without calling Magento.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);

  if (!MAGENTO_CONFIG.token && !options.dryRun) {
    throw new Error('MAGENTO_KEY is required in environment variables');
  }

  if (!Number.isInteger(options.status) || options.status < 1) {
    throw new Error('Invalid --status. Expected a positive integer.');
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Invalid --concurrency. Expected integer >= 1.');
  }

  const auditReportPath = options.file ? path.resolve(process.cwd(), options.file) : findLatestAuditReport();
  const skus = readConfirmedSkus(auditReportPath, options.limit, options.excludeSkus);

  console.log(`Audit report: ${auditReportPath}`);
  console.log(`Confirmed SKUs to disable: ${skus.length}`);
  console.log(`Target status: ${options.status}`);
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'live'}`);
  if (options.excludeSkus.length > 0) {
    console.log(`Excluded SKUs: ${options.excludeSkus.join(', ')}`);
  }

  if (skus.length === 0) {
    console.log('No confirmed matching SKUs found. Nothing to disable.');
    return;
  }

  const storeViewCodes = options.dryRun ? ['all', 'default', 'us_sv'] : await discoverStoreViewCodes();
  console.log(`Store views: ${storeViewCodes.join(', ')}`);

  const rows = await processInChunks(skus, options, storeViewCodes);
  const outputPath = buildOutputPath(options.output, options.dryRun);
  const successfulRows = rows.filter((row) => row.success);
  const failedRows = rows.filter((row) => !row.success);

  writeResultsCsv(rows, outputPath);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        dry_run: options.dryRun,
        attempted_count: rows.length,
        success_count: successfulRows.length,
        failed_count: failedRows.length,
        excluded_skus: options.excludeSkus,
        sample_failures: failedRows.slice(0, 20).map((row) => ({
          sku: row.sku,
          failedStoreViews: row.failedStoreViews.map((entry) => entry.storeViewCode),
        })),
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