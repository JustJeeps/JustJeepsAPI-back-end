const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

function buildRecordKey(entry) {
  const recordedAt = entry.recordedAt instanceof Date
    ? entry.recordedAt.toISOString()
    : String(entry.recordedAt || entry.cancelledAt || '');

  return [
    recordedAt,
    entry.cancelledBy || 'unknown',
    entry.orderId || '',
    entry.incrementId || '',
    entry.requestedOrderIdentifier || '',
    entry.outcome || '',
  ]
    .map((part) => String(part).replace(/\|/g, '%7C'))
    .join('|');
}

function mapEntry(entry) {
  const recordedAt = new Date(entry.recordedAt || entry.cancelledAt || Date.now());
  const cancelledAt = entry.cancelledAt ? new Date(entry.cancelledAt) : null;

  return {
    recordKey: buildRecordKey({ ...entry, recordedAt }),
    recordedAt,
    reportDate: entry.reportDate,
    timeZone: entry.timeZone || 'America/Toronto',
    cancelledAt,
    cancelledBy: entry.cancelledBy || 'unknown',
    dryRun: Boolean(entry.dryRun),
    outcome: entry.outcome || 'unknown',
    orderId: entry.orderId ? Number(entry.orderId) : null,
    incrementId: entry.incrementId || '',
    requestedOrderIdentifier: entry.requestedOrderIdentifier || '',
    orderCancelledInMagento: Boolean(entry.orderCancelledInMagento),
    invoiceVoidDeleteCompleted: Boolean(entry.invoiceVoidDeleteCompleted),
    cancellationTicketSent: Boolean(entry.cancellationTicketSent),
    cancellationAttributesUpdated: Boolean(entry.cancellationAttributesUpdated),
    localStatusUpdated: Boolean(entry.localStatusUpdated),
    failedActions: Array.isArray(entry.failedActions) ? entry.failedActions : [],
    completedActions: Array.isArray(entry.completedActions) ? entry.completedActions : [],
    manualActionsStillRequired: Array.isArray(entry.manualActionsStillRequired) ? entry.manualActionsStillRequired : [],
    orderSnapshot: entry.orderSnapshot || {},
  };
}

async function main() {
  const inputPath = process.argv[2] || path.resolve(__dirname, '..', 'logs', 'order-cancel-workflow-history.json');
  const raw = inputPath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [];
  const data = entries
    .filter((entry) => entry && entry.reportDate && (entry.orderId || entry.incrementId || entry.requestedOrderIdentifier))
    .map(mapEntry);

  if (data.length === 0) {
    console.log('No order cancellation workflow history entries to import.');
    return;
  }

  const result = await prisma.orderCancellationWorkflowHistory.createMany({
    data,
    skipDuplicates: true,
  });

  console.log(`Imported ${result.count} of ${data.length} order cancellation workflow history entries.`);
}

main()
  .catch((error) => {
    console.error('Failed to import order cancellation workflow history:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
