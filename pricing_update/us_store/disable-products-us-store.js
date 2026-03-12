#!/usr/bin/env node

const axios = require('axios');
const dotenv = require('dotenv');
const prisma = require('../../lib/prisma');

dotenv.config();

const MAGENTO_CONFIG = {
  baseURL: process.env.M2_BASE_URL || 'https://www.justjeeps.com/rest/us_sv/V1',
  token: process.env.MAGENTO_KEY,
  timeout: Number(process.env.MAGENTO_TIMEOUT_MS || 10000),
};

function parseArgs(argv) {
  const options = {
    jjPrefix: 'AEV',
    status: 2,
    concurrency: 10,
    limit: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if ((arg === '--jj-prefix' || arg === '--prefix') && argv[i + 1]) {
      options.jjPrefix = argv[++i];
    } else if (arg === '--vendor' && argv[i + 1]) {
      options.jjPrefix = argv[++i];
    } else if (arg === '--status' && argv[i + 1]) {
      options.status = Number(argv[++i]);
    } else if (arg === '--concurrency' && argv[i + 1]) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

async function getSkusByJjPrefix(jjPrefix, limit = null) {
  const normalizedPrefix = (jjPrefix || '').trim();
  if (!normalizedPrefix) {
    throw new Error('jj_prefix is required');
  }

  const products = await prisma.product.findMany({
    where: {
      jj_prefix: {
        equals: normalizedPrefix,
        mode: 'insensitive',
      },
    },
    select: { sku: true },
    ...(limit ? { take: limit } : {}),
    orderBy: { sku: 'asc' },
  });

  return {
    jjPrefix: normalizedPrefix,
    skus: products.map((product) => product.sku),
  };
}

async function setProductStatus(sku, status) {
  const payload = {
    product: {
      status,
    },
  };

  const url = `${MAGENTO_CONFIG.baseURL}/products/${encodeURIComponent(sku)}`;

  const requestConfig = {
    headers: {
      Authorization: `Bearer ${MAGENTO_CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    timeout: MAGENTO_CONFIG.timeout,
  };

  try {
    const response = await axios.put(url, payload, requestConfig);
    return { success: true, sku, method: 'PUT', statusCode: response.status };
  } catch (error) {
    if (error.response?.status === 405) {
      const response = await axios.post(url, payload, requestConfig);
      return { success: true, sku, method: 'POST', statusCode: response.status };
    }

    return {
      success: false,
      sku,
      statusCode: error.response?.status,
      error: error.response?.data || error.message,
    };
  }
}

async function processInChunks(skus, targetStatus, concurrency) {
  const stats = {
    total: skus.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < skus.length; i += concurrency) {
    const chunk = skus.slice(i, i + concurrency);
    console.log(`📦 Updating chunk ${Math.floor(i / concurrency) + 1}/${Math.ceil(skus.length / concurrency)} (${chunk.length} SKUs)`);

    const results = await Promise.all(chunk.map((sku) => setProductStatus(sku, targetStatus)));

    for (const result of results) {
      if (result.success) {
        stats.success++;
        console.log(`  ✅ ${result.sku} (${result.method})`);
      } else {
        stats.failed++;
        stats.errors.push(result);
        console.log(`  ❌ ${result.sku} (${result.statusCode || 'ERR'})`);
      }
    }

    if (i + concurrency < skus.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return stats;
}

function printUsage() {
  console.log('Disable vendor products in Magento US store by setting product status.');
  console.log('');
  console.log('Usage:');
  console.log('  node pricing_update/us_store/disable-products-us-store.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --jj-prefix <code>      Product jj_prefix filter (default: AEV)');
  console.log('  --prefix <code>         Alias for --jj-prefix');
  console.log('  --vendor <code>         Backward-compatible alias for --jj-prefix');
  console.log('  --status <number>       Magento status value (default: 2)');
  console.log('  --concurrency <number>  Concurrent Magento updates (default: 10)');
  console.log('  --limit <number>        Limit products fetched from DB');
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

  if (!Number.isInteger(options.status) || options.status < 1) {
    throw new Error('Invalid --status. Expected a positive integer (use 2 to disable).');
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Invalid --concurrency. Expected integer >= 1.');
  }

  const startedAt = Date.now();

  console.log('🚀 US Store Product Status Update');
  console.log(`🏷️  jj_prefix: ${options.jjPrefix}`);
  console.log(`🎯 Target status: ${options.status}`);
  console.log(`🌐 Endpoint: ${MAGENTO_CONFIG.baseURL}/products/{sku}`);

  const { jjPrefix, skus } = await getSkusByJjPrefix(options.jjPrefix, options.limit);

  console.log(`📋 jj_prefix filter: ${jjPrefix}`);
  console.log(`📦 Unique SKUs found: ${skus.length}`);

  if (skus.length === 0) {
    console.log('⚠️ No SKUs found. Nothing to update.');
    return;
  }

  if (options.dryRun) {
    console.log('🧪 Dry run mode enabled. No Magento updates will be sent.');
    console.log('Sample SKUs:', skus.slice(0, 25));
    return;
  }

  const stats = await processInChunks(skus, options.status, options.concurrency);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const successRate = ((stats.success / stats.total) * 100).toFixed(1);

  console.log('\n✅ Job complete');
  console.log(`   - Total: ${stats.total}`);
  console.log(`   - Success: ${stats.success}`);
  console.log(`   - Failed: ${stats.failed}`);
  console.log(`   - Success rate: ${successRate}%`);
  console.log(`   - Elapsed: ${elapsedSeconds}s`);

  if (stats.failed > 0) {
    console.log('\n❗ Failed SKUs (first 20):');
    stats.errors.slice(0, 20).forEach((err) => {
      console.log(`   - ${err.sku}: ${err.statusCode || 'ERR'} ${JSON.stringify(err.error).slice(0, 200)}`);
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
