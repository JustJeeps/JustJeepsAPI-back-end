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

// Linhas largas (42 colunas + Json de ate 25 transacoes): batch pequeno para
// nao estourar o limite de bind params do Postgres nem o pool de 2 conexoes.
const BATCH_SIZE = 500;

// Aborta se o novo snapshot tiver menos que esta fracao de clientes do import
// anterior (export truncado nunca substitui dado bom).
const MIN_RATIO = Number(process.env.QB_IMPORT_MIN_RATIO || 0.7);

function fileFreshness(filePath) {
  const stats = fs.statSync(filePath);
  const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
  console.log(
    `  ${filePath}\n    modificado: ${stats.mtime.toISOString()} | ${(stats.size / 1024 / 1024).toFixed(1)}MB | idade: ${ageHours.toFixed(1)}h`
  );
  return stats.mtime;
}

async function seedQuickBooksCustomers() {
  const startedAt = Date.now();
  console.log('=== Seed QuickBooks Customers ===');

  for (const filePath of [CUSTOMER_CSV_PATH, TRANSACTION_CSV_PATH]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo CSV nao encontrado: ${filePath}`);
    }
  }

  console.log('Arquivos de origem:');
  const customersMtime = fileFreshness(CUSTOMER_CSV_PATH);
  const transactionsMtime = fileFreshness(TRANSACTION_CSV_PATH);
  // O snapshot e tao velho quanto o export mais antigo dos dois.
  const sourceExportedAt = customersMtime < transactionsMtime ? customersMtime : transactionsMtime;

  console.log('Parseando CSVs...');
  const customers = loadCustomers(CUSTOMER_CSV_PATH);
  const transactionsByCustomer = loadTransactions(TRANSACTION_CSV_PATH);
  console.log(`  clientes: ${customers.length} | clientes com transacoes: ${transactionsByCustomer.size}`);

  if (!customers.length) {
    throw new Error('CSV de clientes vazio - import abortado');
  }

  const previousImport = await prisma.quickBooksImport.findFirst({
    where: { status: 'complete' },
    orderBy: { id: 'desc' },
  });

  if (previousImport && customers.length < previousImport.customers * MIN_RATIO) {
    throw new Error(
      `Contagem de clientes colapsou: ${customers.length} vs ${previousImport.customers} do import anterior ` +
      `(minimo aceito: ${Math.ceil(previousImport.customers * MIN_RATIO)}). Export truncado? Import abortado.`
    );
  }

  const currentImport = await prisma.quickBooksImport.create({
    data: { status: 'pending', sourceExportedAt },
  });
  console.log(`Import #${currentImport.id} criado (pending). Montando linhas...`);

  // Dedupe defensivo por customerCode (last-wins, espelha o Map do modo csv).
  const rowByCode = new Map();
  customers.forEach((customer) => {
    const stats = calculateStats(transactionsByCustomer.get(customer.customerCode) || []);
    rowByCode.set(customer.customerCode, buildCustomerRow(customer, stats, currentImport.id));
  });
  const rows = [...rowByCode.values()];
  if (rows.length !== customers.length) {
    console.warn(`  aviso: ${customers.length - rows.length} customerCode duplicados descartados (last-wins)`);
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
      `Contagem inserida (${insertedCount}) difere do esperado (${rows.length}) - import #${currentImport.id} mantido como pending para investigacao`
    );
  }

  // Ponto atomico do swap: leituras passam a resolver este import.
  await prisma.quickBooksImport.update({
    where: { id: currentImport.id },
    data: {
      status: 'complete',
      customers: insertedCount,
      transactionsGroupedCustomers: transactionsByCustomer.size,
      errors: [],
    },
  });
  console.log(`Import #${currentImport.id} completo: ${insertedCount} clientes.`);

  const removedRows = await prisma.quickBooksCustomer.deleteMany({
    where: { importId: { not: currentImport.id } },
  });
  const supersededImports = await prisma.quickBooksImport.updateMany({
    where: { id: { not: currentImport.id }, status: 'complete' },
    data: { status: 'superseded' },
  });
  console.log(`Cleanup: ${removedRows.count} linhas de snapshots antigos removidas, ${supersededImports.count} imports marcados como superseded.`);

  console.log(`=== Concluido em ${((Date.now() - startedAt) / 1000).toFixed(1)}s ===`);
}

seedQuickBooksCustomers()
  .catch((error) => {
    console.error('Seed QuickBooks Customers falhou:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
