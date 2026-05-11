#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { stringify } = require('csv-stringify/sync');

const COLUMN_INDEX = {
  customer: 1,
  type: 4,
  invoiceDate: 6,
  invoiceNo: 8,
  dueDate: 14,
  itemAmount: 22,
};

const OUTPUT_HEADERS = [
  'InvoiceNo',
  'Customer',
  'InvoiceDate',
  'DueDate',
  'Product/Service',
  'ItemAmount',
  'ItemTaxCode',
];

const STATIC_VALUES = {
  productService: 'Historical Invoice Import',
  itemTaxCode: 'Out of Scope',
};

function printUsage() {
  console.error(
    'Usage: node "QuickBooks Project/convert-qb-open-invoices-to-qbo.js" <input-file> [output-file]'
  );
}

function getCell(row, index) {
  return row[index] ?? '';
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isTotalLabel(value) {
  return /^total\b/i.test(normalizeText(value));
}

function formatDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = normalizeText(value);
  if (!text) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString().slice(0, 10);
  }

  return text;
}

function parseAmount(value) {
  const text = normalizeText(value).replace(/,/g, '');
  if (!text) {
    return null;
  }

  const amount = Number(text);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return amount;
}

function getDefaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}-qbo-import.csv`);
}

function readRows(inputPath) {
  const workbook = XLSX.readFile(inputPath, {
    cellDates: true,
    dateNF: 'yyyy-mm-dd',
    raw: false,
  });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('No worksheet found in input file.');
  }

  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    defval: '',
    raw: false,
  });
}

function convertRows(rows) {
  let latestCustomer = '';
  let invoiceCount = 0;
  let totalAmount = 0;
  const outputRows = [];

  for (const row of rows) {
    const customerCell = normalizeText(getCell(row, COLUMN_INDEX.customer));
    const type = normalizeText(getCell(row, COLUMN_INDEX.type));

    if (customerCell && !isTotalLabel(customerCell)) {
      latestCustomer = customerCell;
    }

    if (type !== 'Invoice') {
      continue;
    }

    const invoiceNo = normalizeText(getCell(row, COLUMN_INDEX.invoiceNo));
    const amount = parseAmount(getCell(row, COLUMN_INDEX.itemAmount));

    if (!latestCustomer || !invoiceNo || amount === null) {
      continue;
    }

    outputRows.push({
      InvoiceNo: invoiceNo,
      Customer: latestCustomer,
      InvoiceDate: formatDate(getCell(row, COLUMN_INDEX.invoiceDate)),
      DueDate: formatDate(getCell(row, COLUMN_INDEX.dueDate)),
      'Product/Service': STATIC_VALUES.productService,
      ItemAmount: amount.toFixed(2),
      ItemTaxCode: STATIC_VALUES.itemTaxCode,
    });

    invoiceCount += 1;
    totalAmount += amount;
  }

  return { outputRows, invoiceCount, totalAmount };
}

function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    printUsage();
    process.exit(1);
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = path.resolve(process.cwd(), outputArg || getDefaultOutputPath(inputPath));

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const rows = readRows(inputPath);
  const { outputRows, invoiceCount, totalAmount } = convertRows(rows);
  const csv = stringify(outputRows, {
    header: true,
    columns: OUTPUT_HEADERS,
  });

  fs.writeFileSync(outputPath, csv, 'utf8');

  console.log(`Output CSV: ${outputPath}`);
  console.log(`Invoice count: ${invoiceCount}`);
  console.log(`Total ItemAmount: ${totalAmount.toFixed(2)}`);
}

main();