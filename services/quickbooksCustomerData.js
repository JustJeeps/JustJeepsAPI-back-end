const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Logica pura do QuickBooks Customer Lookup, compartilhada entre o service
// (modos csv e db) e o seeder que importa os CSVs para o Postgres.

const ACTIVE_TYPES = new Set([
  'Invoice',
  'Payment',
  'Credit Memo',
  'Sales Receipt',
  'Cheque',
  'Credit Card Refund',
  'Credit Card Charge',
  'Credit Card Credit',
  'General Journal',
  'Sales Order',
  'Estimate',
]);

const PURCHASE_TYPES = new Set(['Invoice', 'Sales Receipt']);
const PAYMENT_TYPES = new Set(['Payment', 'Cheque', 'Credit Card Charge', 'Sales Receipt']);
const CREDIT_TYPES = new Set(['Credit Memo', 'Credit Card Refund', 'Credit Card Credit']);

// Sentinela para lastPurchaseDate ausente: Date.parse('') vira NaN -> 0 no sort
// atual, entao "sem compra" ordena como epoch.
const EPOCH = new Date(0);

function nonEmpty(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return nonEmpty(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(value) {
  return nonEmpty(value).replace(/\D/g, '');
}

function normalizeDisplayPhone(value) {
  const raw = nonEmpty(value);
  if (!raw) return '';

  const lowered = raw.toLowerCase();
  if (lowered === '-' || lowered === '--' || lowered === 'n/a' || lowered === 'na') {
    return '';
  }

  return raw;
}

function normalizePhoneVariants(digits) {
  const raw = nonEmpty(digits).replace(/\D/g, '');
  if (!raw) return [];

  const variants = new Set([raw]);

  // Normalize North American prefix variations (1 + 10-digit number).
  if (raw.length === 11 && raw.startsWith('1')) {
    variants.add(raw.slice(1));
  }
  if (raw.length === 10) {
    variants.add(`1${raw}`);
  }

  return [...variants];
}

function extractPhoneCandidates(text) {
  const source = nonEmpty(text);
  if (!source) return [];

  const formattedMatches = source.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g) || [];
  const compactMatches = source.match(/\b(?:1\d{10}|\d{10})\b/g) || [];
  const matches = [...formattedMatches, ...compactMatches];
  if (!matches.length) return [];

  return matches
    .map((match) => normalizePhone(match))
    .filter((digits) => digits.length >= 10);
}

function extractDisplayPhoneFromText(text) {
  const source = nonEmpty(text);
  if (!source) return '';

  const formattedMatches = source.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g) || [];
  const compactMatches = source.match(/\b(?:1\d{10}|\d{10})\b/g) || [];
  const matches = [...formattedMatches, ...compactMatches];
  if (!matches || !matches.length) return '';

  // Prefer the last matched phone sequence because Invoice To often ends with phone.
  return nonEmpty(matches[matches.length - 1]);
}

function buildPhoneSearchDigits(mainPhone, invoiceToAddress) {
  const candidates = new Set();

  const addWithVariants = (digits) => {
    normalizePhoneVariants(digits).forEach((variant) => {
      if (variant.length >= 10) {
        candidates.add(variant);
      }
    });
  };

  addWithVariants(normalizePhone(mainPhone));
  extractPhoneCandidates(invoiceToAddress).forEach(addWithVariants);

  return [...candidates];
}

function hasPhoneMatch(customer, queryDigits) {
  const variants = normalizePhoneVariants(queryDigits);
  if (!variants.length) return false;

  const searchable = Array.isArray(customer.phoneSearchDigits)
    ? customer.phoneSearchDigits
    : customer.phoneDigits
      ? normalizePhoneVariants(customer.phoneDigits)
      : [];

  if (!searchable.length) return false;

  return variants.some((queryVariant) => searchable.some((storedVariant) => (
    storedVariant.includes(queryVariant) || queryVariant.includes(storedVariant)
  )));
}

function isPhoneLikeQuery(value) {
  const raw = nonEmpty(value);
  if (!raw) return false;

  // If query contains letters or an email marker, treat it as non-phone input.
  if (/[a-z@]/i.test(raw)) return false;

  const digits = normalizePhone(raw);
  // Require enough signal to avoid noisy matches like "13".
  return digits.length >= 6;
}

function normalizeCode(value) {
  return nonEmpty(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toUpperCode(value) {
  return nonEmpty(value).toUpperCase();
}

function parseMoney(value) {
  const raw = nonEmpty(value);
  if (!raw) return 0;

  const isNegative = /\(.+\)/.test(raw);
  const normalized = raw.replace(/[$,\s()]/g, '');
  const parsed = Number(normalized);

  if (!Number.isFinite(parsed)) return 0;
  return isNegative ? -parsed : parsed;
}

function roundMoney(value) {
  return Number((value || 0).toFixed(2));
}

function parseDate(value) {
  const raw = nonEmpty(value);
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  return raw;
}

function idx(header, columnName) {
  return header.findIndex((column) => nonEmpty(column) === columnName);
}

function deriveCompanyName({ invoiceTo, firstName, lastName }) {
  const cleaned = nonEmpty(invoiceTo).replace(/^\\\s*/, '').trim();
  if (!cleaned) return '';

  const fullName = normalizeText(`${firstName} ${lastName}`);
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  if (tokens.length <= 1) return cleaned;

  const withoutCode = tokens.slice(1);
  const phoneIndex = withoutCode.findIndex((token) => /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(token));
  const cutAt = phoneIndex >= 0 ? phoneIndex : withoutCode.length;
  const candidate = withoutCode.slice(0, cutAt).join(' ').trim();

  if (!candidate) return cleaned;
  if (fullName && normalizeText(candidate) === fullName) return '';

  return candidate;
}

function getCustomerDisplayName({ firstName, lastName, invoiceTo, customerCode }) {
  const combined = `${nonEmpty(firstName)} ${nonEmpty(lastName)}`.trim();
  if (combined) return combined;

  const derivedCompany = deriveCompanyName({ invoiceTo, firstName, lastName });
  if (derivedCompany) return derivedCompany;

  return customerCode;
}

function normalizeInvoiceToAddress(value) {
  return nonEmpty(value).replace(/^\\\s*/, '').trim();
}

function buildAddress(customer) {
  const parts = [
    customer.street1,
    customer.street2,
    customer.city,
    customer.province,
    customer.postalCode,
    customer.country,
  ].map(nonEmpty).filter(Boolean);

  return parts.join(', ');
}

function getPreferredCustomerName(customer) {
  const fullName = `${nonEmpty(customer.firstName)} ${nonEmpty(customer.lastName)}`.trim();
  if (fullName) return fullName;

  const streetAddress = nonEmpty(customer.street1);
  if (streetAddress) return streetAddress;

  return 'no first and last name on db';
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

// O `contains` do Prisma 4 nao escapa metacaracteres LIKE: sem isto, uma busca
// por "smith%" vira wildcard em vez do literal que o String.includes fazia.
function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function computeYearsAsCustomer(firstPurchaseDate) {
  if (!firstPurchaseDate) return 0;

  const today = new Date();
  const first = new Date(firstPurchaseDate);
  const diffMs = today.getTime() - first.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;

  return Number((diffMs / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1));
}

function buildFraudIndicators({ hasPurchasedBefore, invoiceCount, paymentCount, yearsAsCustomer }) {
  return {
    noPurchaseHistory: !hasPurchasedBefore,
    firstTimeCustomer: invoiceCount === 1 && hasPurchasedBefore,
    significantPurchaseHistory: paymentCount >= 5,
    yearsAsCustomer,
  };
}

function calculateStats(transactions) {
  const activeTransactions = transactions
    .filter((transaction) => ACTIVE_TYPES.has(transaction.type))
    .sort((left, right) => {
      if (left.date && right.date) {
        if (left.date > right.date) return 1;
        if (left.date < right.date) return -1;
      }
      return 0;
    });

  const invoices = activeTransactions.filter((transaction) => PURCHASE_TYPES.has(transaction.type));
  const payments = activeTransactions.filter((transaction) => PAYMENT_TYPES.has(transaction.type));
  const credits = activeTransactions.filter((transaction) => CREDIT_TYPES.has(transaction.type));
  const recentTransactions = [...activeTransactions]
    .sort((left, right) => {
      if (left.date && right.date) {
        if (left.date < right.date) return 1;
        if (left.date > right.date) return -1;
      }
      return 0;
    })
    .slice(0, 25);

  const firstPurchaseDate = payments[0]?.date || null;
  const lastPurchaseDate = payments[payments.length - 1]?.date || null;

  const totalAmountPurchased = payments.reduce((sum, transaction) => sum + safeNumber(transaction.amount, 0), 0);
  const totalCreditAmount = credits.reduce((sum, transaction) => sum + safeNumber(transaction.amount, 0), 0);
  const lifetimeValue = totalAmountPurchased - totalCreditAmount;

  const yearsAsCustomer = computeYearsAsCustomer(firstPurchaseDate);

  const invoiceCount = invoices.length;
  const paymentCount = payments.length;
  const hasPurchasedBefore = paymentCount > 0;

  return {
    hasPurchasedBefore,
    invoiceCount,
    paymentCount,
    totalAmountPurchased: roundMoney(totalAmountPurchased),
    firstPurchaseDate,
    lastPurchaseDate,
    lifetimeValue: roundMoney(lifetimeValue),
    yearsAsCustomer,
    totalCreditAmount: roundMoney(totalCreditAmount),
    fraudIndicators: buildFraudIndicators({ hasPurchasedBefore, invoiceCount, paymentCount, yearsAsCustomer }),
    recentTransactions,
    transactionCount: activeTransactions.length,
  };
}

function loadCustomers(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parse(raw, { relax_column_count: true });
  const header = records[0] || [];

  const customerIndex = idx(header, 'Customer');
  const invoiceToIndex = idx(header, 'Invoice to');
  const emailIndex = idx(header, 'Main Email');
  const firstNameIndex = idx(header, 'First Name');
  const lastNameIndex = idx(header, 'Last Name');
  const phoneIndex = idx(header, 'Main Phone');
  const balanceIndex = idx(header, 'Balance Total');
  const street1Index = idx(header, 'Street1');
  const street2Index = idx(header, 'Street2');
  const cityIndex = idx(header, 'City');
  const provinceIndex = idx(header, 'Province');
  const postalCodeIndex = idx(header, 'Postal Code');
  const countryIndex = idx(header, 'Country');

  return records.slice(1)
    .filter((row) => row.some((value) => nonEmpty(value)))
    .map((row) => {
      const customerCode = toUpperCode(row[customerIndex]);
      const invoiceTo = nonEmpty(row[invoiceToIndex]);
      const invoiceToAddress = normalizeInvoiceToAddress(row[invoiceToIndex]);
      const mainPhone = normalizeDisplayPhone(row[phoneIndex]);
      const fallbackPhone = extractDisplayPhoneFromText(invoiceToAddress);
      const resolvedPhone = mainPhone || fallbackPhone;
      const firstName = nonEmpty(row[firstNameIndex]);
      const lastName = nonEmpty(row[lastNameIndex]);
      const companyName = deriveCompanyName({ invoiceTo, firstName, lastName });
      const customerName = getCustomerDisplayName({
        firstName,
        lastName,
        invoiceTo,
        customerCode,
      });

      return {
        customerCode,
        customerName,
        firstName,
        lastName,
        companyName,
        invoiceTo,
        invoiceToAddress,
        email: nonEmpty(row[emailIndex]),
        phone: resolvedPhone,
        phoneDigits: normalizePhone(resolvedPhone),
        phoneSearchDigits: buildPhoneSearchDigits(row[phoneIndex], invoiceToAddress),
        balance: roundMoney(parseMoney(row[balanceIndex])),
        street1: nonEmpty(row[street1Index]),
        street2: nonEmpty(row[street2Index]),
        city: nonEmpty(row[cityIndex]),
        province: nonEmpty(row[provinceIndex]),
        postalCode: nonEmpty(row[postalCodeIndex]),
        country: nonEmpty(row[countryIndex]),
      };
    })
    .filter((customer) => customer.customerCode);
}

function loadTransactions(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parse(raw, { relax_column_count: true });
  const header = records[0] || [];

  const typeIndex = idx(header, 'Type');
  const dateIndex = idx(header, 'Date');
  const numIndex = idx(header, 'Num');
  const nameIndex = idx(header, 'Name');
  const memoIndex = idx(header, 'Memo');
  const accountIndex = idx(header, 'Account');
  const debitIndex = idx(header, 'Debit');
  const creditIndex = idx(header, 'Credit');

  const grouped = new Map();

  records.slice(1)
    .filter((row) => row.some((value) => nonEmpty(value)))
    .forEach((row) => {
      const type = nonEmpty(row[typeIndex]);
      const customerCode = toUpperCode(row[nameIndex]);

      if (!type || !customerCode || !ACTIVE_TYPES.has(type)) {
        return;
      }

      const debit = parseMoney(row[debitIndex]);
      const credit = parseMoney(row[creditIndex]);
      const amount = debit > 0 ? debit : credit;

      const normalized = {
        type,
        date: parseDate(row[dateIndex]),
        referenceNumber: nonEmpty(row[numIndex]),
        memo: nonEmpty(row[memoIndex]),
        account: nonEmpty(row[accountIndex]),
        debit: roundMoney(debit),
        credit: roundMoney(credit),
        amount: roundMoney(amount),
      };

      if (!grouped.has(customerCode)) {
        grouped.set(customerCode, []);
      }

      grouped.get(customerCode).push(normalized);
    });

  return grouped;
}

// ---------------------------------------------------------------------------
// Builders para o modo db: linha do QuickBooksCustomer e respostas da API.
// ---------------------------------------------------------------------------

function parseSortableDate(rawDate) {
  if (!rawDate) return EPOCH;
  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? EPOCH : parsed;
}

function buildCustomerRow(customer, stats, importId) {
  const address = customer.invoiceToAddress || buildAddress(customer);
  const displayName = getPreferredCustomerName(customer);

  return {
    importId,
    customerCode: customer.customerCode,

    searchName: customer.customerName,
    firstName: customer.firstName,
    lastName: customer.lastName,
    companyName: customer.companyName,
    invoiceTo: customer.invoiceTo,
    invoiceToAddress: customer.invoiceToAddress,
    email: customer.email,
    phone: customer.phone,
    phoneDigits: customer.phoneDigits,
    balance: customer.balance,
    street1: customer.street1,
    street2: customer.street2,
    city: customer.city,
    province: customer.province,
    postalCode: customer.postalCode,
    country: customer.country,

    displayName,
    address,

    searchNameNorm: normalizeText(customer.customerName),
    displayNameNorm: normalizeText(displayName),
    emailNorm: normalizeText(customer.email),
    addressNorm: normalizeText(address),
    codeNorm: normalizeCode(customer.customerCode),
    codeSort: normalizeText(customer.customerCode),
    phoneSearch: customer.phoneSearchDigits.join(' '),
    phoneSortDigits: normalizePhone(customer.phone),

    hasPurchasedBefore: stats.hasPurchasedBefore,
    invoiceCount: stats.invoiceCount,
    paymentCount: stats.paymentCount,
    totalAmountPurchased: stats.totalAmountPurchased,
    totalCreditAmount: stats.totalCreditAmount,
    lifetimeValue: stats.lifetimeValue,
    firstPurchaseDate: stats.firstPurchaseDate,
    lastPurchaseDate: stats.lastPurchaseDate,
    lastPurchaseSortAt: parseSortableDate(stats.lastPurchaseDate),
    transactionCount: stats.transactionCount,
    recentTransactions: stats.recentTransactions,
  };
}

function buildSearchResultFromRow(row) {
  const yearsAsCustomer = computeYearsAsCustomer(row.firstPurchaseDate);

  return {
    customerCode: row.customerCode,
    customerName: row.displayName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    currentQuickBooksBalance: row.balance,
    hasPurchasedBefore: row.hasPurchasedBefore,
    totalInvoices: row.invoiceCount,
    totalPayments: row.paymentCount,
    totalAmountPurchased: row.totalAmountPurchased,
    firstPurchaseDate: row.firstPurchaseDate,
    lastPurchaseDate: row.lastPurchaseDate,
    lifetimeValue: row.lifetimeValue,
    yearsAsCustomer,
    fraudIndicators: buildFraudIndicators({
      hasPurchasedBefore: row.hasPurchasedBefore,
      invoiceCount: row.invoiceCount,
      paymentCount: row.paymentCount,
      yearsAsCustomer,
    }),
  };
}

function buildDetailResponseFromRow(row) {
  const yearsAsCustomer = computeYearsAsCustomer(row.firstPurchaseDate);

  return {
    customerCode: row.customerCode,
    customerName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
    invoiceTo: row.invoiceTo,
    invoiceToAddress: row.invoiceToAddress,
    email: row.email,
    phone: row.phone,
    phoneDigits: row.phoneDigits,
    phoneSearchDigits: row.phoneSearch ? row.phoneSearch.split(' ').filter(Boolean) : [],
    balance: row.balance,
    street1: row.street1,
    street2: row.street2,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    country: row.country,
    address: row.address,
    currentQuickBooksBalance: row.balance,
    analysis: {
      hasPurchasedBefore: row.hasPurchasedBefore,
      totalInvoices: row.invoiceCount,
      totalPayments: row.paymentCount,
      totalAmountPurchased: row.totalAmountPurchased,
      firstPurchaseDate: row.firstPurchaseDate,
      lastPurchaseDate: row.lastPurchaseDate,
      lifetimeValue: row.lifetimeValue,
      yearsAsCustomer,
      fraudIndicators: buildFraudIndicators({
        hasPurchasedBefore: row.hasPurchasedBefore,
        invoiceCount: row.invoiceCount,
        paymentCount: row.paymentCount,
        yearsAsCustomer,
      }),
    },
    recentTransactions: row.recentTransactions || [],
    transactionCount: row.transactionCount,
  };
}

module.exports = {
  ACTIVE_TYPES,
  PURCHASE_TYPES,
  PAYMENT_TYPES,
  CREDIT_TYPES,
  nonEmpty,
  normalizeText,
  normalizePhone,
  normalizeDisplayPhone,
  normalizePhoneVariants,
  extractPhoneCandidates,
  extractDisplayPhoneFromText,
  buildPhoneSearchDigits,
  hasPhoneMatch,
  isPhoneLikeQuery,
  normalizeCode,
  toUpperCode,
  parseMoney,
  roundMoney,
  parseDate,
  deriveCompanyName,
  getCustomerDisplayName,
  normalizeInvoiceToAddress,
  buildAddress,
  getPreferredCustomerName,
  safeNumber,
  escapeLikePattern,
  computeYearsAsCustomer,
  buildFraudIndicators,
  calculateStats,
  loadCustomers,
  loadTransactions,
  buildCustomerRow,
  buildSearchResultFromRow,
  buildDetailResponseFromRow,
};
