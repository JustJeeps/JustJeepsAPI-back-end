const fs = require('fs');
const prisma = require('../../../lib/prisma');
const {
  calculateStats,
  loadCustomers,
  loadTransactions,
  buildCustomerRow,
} = require('../../../services/quickbooksCustomerData');
const {
  CUSTOMER_CSV_PATH,
  TRANSACTION_CSV_PATH,
} = require('../../../services/quickbooksCustomerLookup');
const catalog = require('../../../lib/feeds/catalog');
const feedsConfig = require('../../../config/feeds');

// The feed the exports arrive through when they are uploaded from the panel.
const FEED = 'quickbooks';

// Wide rows (42 columns + JSON with up to 25 transactions): small batch so we
// do not blow past the Postgres bind param limit or the pool of 2 connections.
const BATCH_SIZE = 500;

// Aborts if the new snapshot has fewer customers than this fraction of the
// previous import (a truncated export must never replace good data).
const MIN_RATIO = Number(process.env.QB_IMPORT_MIN_RATIO || 0.7);

function fileFreshness(filePath) {
  const stats = fs.statSync(filePath);
  const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
  console.log(
    `  ${filePath}\n    modified: ${stats.mtime.toISOString()} | ${(stats.size / 1024 / 1024).toFixed(1)}MB | age: ${ageHours.toFixed(1)}h`
  );
  return stats.mtime;
}

// When the exports come from the bucket, the local file is a symlink into the
// feed cache and its mtime is when we DOWNLOADED it, not when the export was
// taken. Reading that would make every snapshot look brand new and would quietly
// disable the staleness alert, which is the whole reason this data is watched.
// The upload time of the batch is the honest answer; the mtime stays as the
// fallback for the legacy path (files copied to the inbox by hand).
async function resolveSourceExportedAt(fallback) {
  const feed = feedsConfig.getFeedByName(FEED);
  if (!feed) return fallback;

  try {
    const batch = await catalog.getCurrentBatch(prisma, feed.name, feed.files);
    if (!batch) return fallback;
    console.log(`  source: batch ${batch.batchId} uploaded ${batch.uploadedAt.toISOString()}`);
    return batch.uploadedAt;
  } catch (error) {
    console.warn(`  could not read the feed catalog (${error.message}), using the file dates`);
    return fallback;
  }
}

async function seedQuickBooksCustomers() {
  const startedAt = Date.now();
  console.log('=== Seed QuickBooks Customers ===');

  for (const filePath of [CUSTOMER_CSV_PATH, TRANSACTION_CSV_PATH]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }
  }

  console.log('Source files:');
  const customersMtime = fileFreshness(CUSTOMER_CSV_PATH);
  const transactionsMtime = fileFreshness(TRANSACTION_CSV_PATH);
  // The snapshot is only as fresh as the older of the two exports.
  const oldestMtime = customersMtime < transactionsMtime ? customersMtime : transactionsMtime;
  const sourceExportedAt = await resolveSourceExportedAt(oldestMtime);

  console.log('Parsing CSVs...');
  const customers = loadCustomers(CUSTOMER_CSV_PATH);
  const transactionsByCustomer = loadTransactions(TRANSACTION_CSV_PATH);
  console.log(`  customers: ${customers.length} | customers with transactions: ${transactionsByCustomer.size}`);

  if (!customers.length) {
    throw new Error('Customer CSV is empty: import aborted');
  }

  const previousImport = await prisma.quickBooksImport.findFirst({
    where: { status: 'complete' },
    orderBy: { id: 'desc' },
  });

  if (previousImport && customers.length < previousImport.customers * MIN_RATIO) {
    throw new Error(
      `Customer count collapsed: ${customers.length} vs ${previousImport.customers} from the previous import ` +
      `(minimum accepted: ${Math.ceil(previousImport.customers * MIN_RATIO)}). Truncated export? Import aborted.`
    );
  }

  const currentImport = await prisma.quickBooksImport.create({
    data: { status: 'pending', sourceExportedAt },
  });
  console.log(`Import #${currentImport.id} created (pending). Building rows...`);

  // Defensive dedupe by customerCode (last wins, mirrors the Map used in csv mode).
  const rowByCode = new Map();
  customers.forEach((customer) => {
    const stats = calculateStats(transactionsByCustomer.get(customer.customerCode) || []);
    rowByCode.set(customer.customerCode, buildCustomerRow(customer, stats, currentImport.id));
  });
  const rows = [...rowByCode.values()];
  if (rows.length !== customers.length) {
    console.warn(`  warning: ${customers.length - rows.length} duplicate customerCode values discarded (last wins)`);
  }

  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await prisma.quickBooksCustomer.createMany({ data: batch, skipDuplicates: true });
    const batchNumber = i / BATCH_SIZE + 1;
    if (batchNumber % 20 === 0 || batchNumber === totalBatches) {
      console.log(`  batch ${batchNumber}/${totalBatches} (${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length})`);
    }
  }

  const insertedCount = await prisma.quickBooksCustomer.count({
    where: { importId: currentImport.id },
  });
  if (insertedCount !== rows.length) {
    throw new Error(
      `Inserted count (${insertedCount}) differs from expected (${rows.length}): import #${currentImport.id} kept as pending for investigation`
    );
  }

  // Atomic swap point: reads start resolving to this import.
  await prisma.quickBooksImport.update({
    where: { id: currentImport.id },
    data: {
      status: 'complete',
      customers: insertedCount,
      transactionsGroupedCustomers: transactionsByCustomer.size,
      errors: [],
    },
  });
  console.log(`Import #${currentImport.id} complete: ${insertedCount} customers.`);

  const removedRows = await prisma.quickBooksCustomer.deleteMany({
    where: { importId: { not: currentImport.id } },
  });
  const supersededImports = await prisma.quickBooksImport.updateMany({
    where: { id: { not: currentImport.id }, status: 'complete' },
    data: { status: 'superseded' },
  });
  console.log(`Cleanup: ${removedRows.count} rows from old snapshots removed, ${supersededImports.count} imports marked as superseded.`);

  console.log(`=== Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ===`);
}

seedQuickBooksCustomers()
  .catch((error) => {
    console.error('Seed QuickBooks Customers failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
