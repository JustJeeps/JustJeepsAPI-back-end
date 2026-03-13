#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../lib/prisma');

dotenv.config();

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_DEFAULT_BASE_URL || 'https://www.justjeeps.com/rest/default/V1',
  token: process.env.MAGENTO_KEY,
  storeId: Number(process.env.MAGENTO_DEFAULT_STORE_ID || 1),
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 30000),
  maxSafeConcurrency: Number(process.env.MAGENTO_MAX_SAFE_CONCURRENCY || 20),
  blackFridayAttributeCode: process.env.MAGENTO_BF_ATTRIBUTE_CODE || 'black_friday_sale_attribute',
  noSaleOptionValue: process.env.MAGENTO_BF_NO_SALE_OPTION_ID || '4589',
};

function parseArgs(argv) {
  const options = {
    targetDbValue: 'no_sale',
    concurrency: 20,
    retries: 3,
    retryDelayMs: 1200,
    chunkDelayMs: 1000,
    limit: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--target-value' && argv[i + 1]) {
      options.targetDbValue = argv[++i];
    } else if (arg === '--concurrency' && argv[i + 1]) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--retries' && argv[i + 1]) {
      options.retries = Number(argv[++i]);
    } else if (arg === '--retry-delay-ms' && argv[i + 1]) {
      options.retryDelayMs = Number(argv[++i]);
    } else if (arg === '--chunk-delay-ms' && argv[i + 1]) {
      options.chunkDelayMs = Number(argv[++i]);
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function normalize(value) {
  return (value || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  const status = error?.response?.status;
  const code = error?.code;

  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (code === 'UPSTREAM_TIMEOUT_HTML') return true;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') return true;

  return false;
}

function isUpstreamTimeoutHtml(response) {
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  const data = response?.data;
  const body = typeof data === 'string' ? data : '';

  if (!body) return false;

  const looksLikeHtml = contentType.includes('text/html') || body.includes('<html');
  if (!looksLikeHtml) return false;

  const timeoutMarkers = [
    'HTTP 504',
    'Hosting Server Read Timeout',
    'Sucuri Firewall',
    'Unable to Read from the Origin Server',
  ];

  return timeoutMarkers.some((marker) => body.includes(marker));
}

function buildUpstreamTimeoutError(response) {
  const error = new Error('Upstream returned HTML timeout page');
  error.code = 'UPSTREAM_TIMEOUT_HTML';
  error.response = {
    status: response?.status || 504,
    data: typeof response?.data === 'string' ? response.data.slice(0, 400) : response?.data,
  };
  return error;
}

function normalizeSaleValue(value) {
  return normalize(value).replace(/[_\s]/g, '');
}

function isDbNoSaleValue(value, targetDbValue) {
  const normalizedValue = normalizeSaleValue(value);
  const normalizedTarget = normalizeSaleValue(targetDbValue);

  const noSaleAliases = new Set([
    normalizedTarget,
    'nosale',
    '15%off',
  ]);

  return noSaleAliases.has(normalizedValue);
}

async function getProductsMissingNoSale(targetDbValue, limit = null) {
  const products = await prisma.product.findMany({
    select: {
      sku: true,
      black_friday_sale: true,
    },
    orderBy: { sku: 'asc' },
  });

  // Extra guard in JS to ensure exact intent regardless of DB collation quirks
  const filtered = products.filter(
    (product) => !isDbNoSaleValue(product.black_friday_sale, targetDbValue)
  );

  return limit ? filtered.slice(0, limit) : filtered;
}

async function updateProductToNoSale(sku, options) {
  const payload = {
    product: {
      sku,
      custom_attributes: [
        {
          attribute_code: MAGENTO_CONFIG.blackFridayAttributeCode,
          value: MAGENTO_CONFIG.noSaleOptionValue,
        },
      ],
    },
  };

  const url = `${MAGENTO_CONFIG.baseURL}/products/${encodeURIComponent(sku)}?storeId=${MAGENTO_CONFIG.storeId}`;

  const requestConfig = {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    timeout: MAGENTO_CONFIG.timeout,
    maxBodyLength: Infinity,
  };

  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    try {
      const response = await axios.put(url, payload, requestConfig);
      if (isUpstreamTimeoutHtml(response)) {
        throw buildUpstreamTimeoutError(response);
      }
      return { success: true, sku, method: 'PUT', statusCode: response.status, attempts: attempt };
    } catch (error) {
      if (error.response?.status === 405) {
        try {
          const response = await axios.post(url, payload, requestConfig);
          if (isUpstreamTimeoutHtml(response)) {
            throw buildUpstreamTimeoutError(response);
          }
          return { success: true, sku, method: 'POST', statusCode: response.status, attempts: attempt };
        } catch (postError) {
          if (attempt <= options.retries && shouldRetry(postError)) {
            await sleep(options.retryDelayMs * attempt);
            continue;
          }

          return {
            success: false,
            sku,
            statusCode: postError.response?.status,
            errorCode: postError.code,
            error: postError.response?.data || postError.message,
          };
        }
      }

      if (attempt <= options.retries && shouldRetry(error)) {
        await sleep(options.retryDelayMs * attempt);
        continue;
      }

      return {
        success: false,
        sku,
        statusCode: error.response?.status,
        errorCode: error.code,
        error: error.response?.data || error.message,
      };
    }
  }

  return {
    success: false,
    sku,
    error: 'Unknown retry termination',
  };
}

async function processInChunks(products, options) {
  const stats = {
    total: products.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < products.length; i += options.concurrency) {
    const chunk = products.slice(i, i + options.concurrency);
    console.log(`📦 Updating chunk ${Math.floor(i / options.concurrency) + 1}/${Math.ceil(products.length / options.concurrency)} (${chunk.length} SKUs)`);

    const results = await Promise.all(chunk.map((product) => updateProductToNoSale(product.sku, options)));

    for (const result of results) {
      if (result.success) {
        stats.success++;
        console.log(`  ✅ ${result.sku} (${result.method}, attempts=${result.attempts || 1})`);
      } else {
        stats.failed++;
        stats.errors.push(result);
        console.log(`  ❌ ${result.sku} (${result.statusCode || result.errorCode || 'ERR'})`);
      }
    }

    if (i + options.concurrency < products.length) {
      await sleep(options.chunkDelayMs);
    }
  }

  return stats;
}

function printUsage() {
  console.log('Update Magento products to Black Friday no_sale option when DB value is not no_sale.');
  console.log('');
  console.log('Usage:');
  console.log('  node magento_update/update-black-friday-no-sale.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --target-value <text>   DB target value to enforce (default: no_sale; aliases include 15%off)');
  console.log('  --concurrency <number>  Concurrent Magento updates (default: 20)');
  console.log('                          Safety cap applies (default max: 20, env: MAGENTO_MAX_SAFE_CONCURRENCY)');
  console.log('  --retries <number>      Retries per SKU for timeout/429/5xx (default: 3)');
  console.log('  --retry-delay-ms <ms>   Base retry delay in ms (default: 1200)');
  console.log('  --chunk-delay-ms <ms>   Delay between chunks in ms (default: 1000)');
  console.log('  --limit <number>        Limit how many DB products are processed');
  console.log('  --dry-run               Print SKUs only, do not update Magento');
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

  if (!Number.isInteger(MAGENTO_CONFIG.maxSafeConcurrency) || MAGENTO_CONFIG.maxSafeConcurrency < 1) {
    throw new Error('Invalid MAGENTO_MAX_SAFE_CONCURRENCY. Expected integer >= 1.');
  }

  if (options.concurrency > MAGENTO_CONFIG.maxSafeConcurrency) {
    throw new Error(
      `Concurrency ${options.concurrency} exceeds safety cap ${MAGENTO_CONFIG.maxSafeConcurrency}. ` +
      `Use --concurrency <= ${MAGENTO_CONFIG.maxSafeConcurrency} or set MAGENTO_MAX_SAFE_CONCURRENCY intentionally.`
    );
  }

  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new Error('Invalid --retries. Expected integer >= 0.');
  }

  if (!Number.isInteger(options.retryDelayMs) || options.retryDelayMs < 0) {
    throw new Error('Invalid --retry-delay-ms. Expected integer >= 0.');
  }

  if (!Number.isInteger(options.chunkDelayMs) || options.chunkDelayMs < 0) {
    throw new Error('Invalid --chunk-delay-ms. Expected integer >= 0.');
  }

  if (!Number.isInteger(MAGENTO_CONFIG.storeId) || MAGENTO_CONFIG.storeId < 1) {
    throw new Error('Invalid MAGENTO_DEFAULT_STORE_ID. Expected integer >= 1.');
  }

  const startedAt = Date.now();

  console.log('🚀 Magento Black Friday no_sale Update');
  console.log(`🎯 Target DB value: ${options.targetDbValue}`);
  console.log('🧭 DB no_sale aliases recognized: no_sale, 15%off, 15% off');
  console.log(`🏬 Store ID: ${MAGENTO_CONFIG.storeId}`);
  console.log(`🌐 Endpoint: ${MAGENTO_CONFIG.baseURL}/products/{sku}?storeId=${MAGENTO_CONFIG.storeId}`);
  console.log(`🏷️  Attribute: ${MAGENTO_CONFIG.blackFridayAttributeCode}=${MAGENTO_CONFIG.noSaleOptionValue}`);
  console.log(`⚙️  Concurrency=${options.concurrency}/${MAGENTO_CONFIG.maxSafeConcurrency} (safe cap), Retries=${options.retries}, TimeoutMs=${MAGENTO_CONFIG.timeout}`);

  const products = await getProductsMissingNoSale(options.targetDbValue, options.limit);
  console.log(`📦 Products to update: ${products.length}`);

  if (products.length === 0) {
    console.log('✅ Nothing to update.');
    return;
  }

  if (options.dryRun) {
    console.log('🧪 Dry run mode enabled. No Magento updates will be sent.');
    console.log('Sample records (SKU -> DB black_friday_sale):');
    products.slice(0, 25).forEach((product) => {
      console.log(`   - ${product.sku} -> ${product.black_friday_sale ?? 'NULL'}`);
    });
    return;
  }

  const stats = await processInChunks(products, options);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const elapsedMinutes = ((Date.now() - startedAt) / 60000).toFixed(2);
  const successRate = ((stats.success / stats.total) * 100).toFixed(1);

  console.log('\n✅ Job complete');
  console.log(`   - Total: ${stats.total}`);
  console.log(`   - Success: ${stats.success}`);
  console.log(`   - Failed: ${stats.failed}`);
  console.log(`   - Success rate: ${successRate}%`);
  console.log(`   - Elapsed: ${elapsedSeconds}s`);
  console.log(`   - Elapsed: ${elapsedMinutes} min`);

  if (stats.failed > 0) {
    console.log('\n❗ Failed SKUs (first 20):');
    stats.errors.slice(0, 20).forEach((err) => {
      console.log(`   - ${err.sku}: ${err.statusCode || err.errorCode || 'ERR'} ${JSON.stringify(err.error).slice(0, 200)}`);
    });
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('❌ Fatal error:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
