const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

function buildRecordKey(entry) {
  const recordedAt = entry.recordedAt instanceof Date
    ? entry.recordedAt.toISOString()
    : String(entry.recordedAt || entry.changedAt || '');

  return [
    recordedAt,
    entry.changedBy || 'unknown',
    entry.source || 'unknown',
    entry.requestedSku || entry.sku || '',
    entry.sku || '',
    entry.status ?? '',
    entry.action || '',
  ]
    .map((part) => String(part).replace(/\|/g, '%7C'))
    .join('|');
}

function mapEntry(entry) {
  const recordedAt = new Date(entry.recordedAt || entry.changedAt || Date.now());
  const status = Number(entry.status);
  const action = entry.action || (status === 2 ? 'disabled' : 'enabled');

  return {
    recordKey: buildRecordKey({ ...entry, recordedAt, action }),
    recordedAt,
    reportDate: entry.reportDate,
    timeZone: entry.timeZone || 'America/Toronto',
    changedBy: entry.changedBy || 'unknown',
    changedByName: entry.changedByName || entry.changedBy || 'unknown',
    changedByEmail: entry.changedByEmail || '',
    source: entry.source || 'unknown',
    requestedSku: entry.requestedSku || entry.sku || '',
    sku: entry.sku,
    title: entry.title || '',
    status: Number.isFinite(status) ? status : (action === 'disabled' ? 2 : 1),
    action,
    applyToChildren: Boolean(entry.applyToChildren),
    updatedStoreViews: Array.isArray(entry.updatedStoreViews) ? entry.updatedStoreViews : [],
    failedStoreViews: Array.isArray(entry.failedStoreViews) ? entry.failedStoreViews : [],
  };
}

async function main() {
  const inputPath = process.argv[2] || path.resolve(__dirname, '..', 'logs', 'sku-status-change-history.json');
  const raw = inputPath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [];
  const data = entries
    .filter((entry) => entry && entry.sku && entry.reportDate)
    .map(mapEntry);

  if (data.length === 0) {
    console.log('No SKU status history entries to import.');
    return;
  }

  const result = await prisma.skuStatusChangeHistory.createMany({
    data,
    skipDuplicates: true,
  });

  console.log(`Imported ${result.count} of ${data.length} SKU status history entries.`);
}

main()
  .catch((error) => {
    console.error('Failed to import SKU status history:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
