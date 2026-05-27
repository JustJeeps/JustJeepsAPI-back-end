const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CUSTOMER_CSV_PATH = path.resolve(
  __dirname,
  '..',
  'QuickBooks Project',
  'customers',
  'customers_qb_desktop.csv'
);

const TRANSACTION_CSV_PATH = path.resolve(
  __dirname,
  '..',
  'QuickBooks Project',
  'customers',
  'transactions_per_customer.csv'
);

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

const cache = {
  loaded: false,
  loadedAt: null,
  customerRecords: [],
  customerByCode: new Map(),
  transactionByCustomer: new Map(),
  customerStatsByCode: new Map(),
  errors: [],
};

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

  const matches = source.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g);
  if (!matches) return [];

  return matches
    .map((match) => normalizePhone(match))
    .filter((digits) => digits.length >= 10);
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

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
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

  let yearsAsCustomer = 0;
  if (firstPurchaseDate) {
    const today = new Date();
    const first = new Date(firstPurchaseDate);
    const diffMs = today.getTime() - first.getTime();
    if (Number.isFinite(diffMs) && diffMs >= 0) {
      yearsAsCustomer = Number((diffMs / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1));
    }
  }

  const invoiceCount = invoices.length;
  const paymentCount = payments.length;
  const hasPurchasedBefore = paymentCount > 0;
  const isFirstTimeCustomer = paymentCount === 1;
  const hasSignificantHistory = paymentCount >= 5 || totalAmountPurchased >= 5000;

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
    fraudIndicators: {
      noPurchaseHistory: !hasPurchasedBefore,
      firstTimeCustomer: isFirstTimeCustomer,
      significantPurchaseHistory: hasSignificantHistory,
      yearsAsCustomer,
    },
    recentTransactions,
    transactionCount: activeTransactions.length,
  };
}

function loadCustomers() {
  const raw = fs.readFileSync(CUSTOMER_CSV_PATH, 'utf8');
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
        phone: nonEmpty(row[phoneIndex]),
        phoneDigits: normalizePhone(row[phoneIndex]),
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

function loadTransactions() {
  const raw = fs.readFileSync(TRANSACTION_CSV_PATH, 'utf8');
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

function loadDataIfNeeded({ forceReload = false } = {}) {
  if (cache.loaded && !forceReload) {
    return cache;
  }

  const nextErrors = [];

  try {
    const customerRecords = loadCustomers();
    const transactionByCustomer = loadTransactions();
    const customerByCode = new Map();
    const customerStatsByCode = new Map();

    customerRecords.forEach((customer) => {
      customerByCode.set(customer.customerCode, customer);

      const customerTransactions = transactionByCustomer.get(customer.customerCode) || [];
      customerStatsByCode.set(customer.customerCode, calculateStats(customerTransactions));
    });

    cache.customerRecords = customerRecords;
    cache.customerByCode = customerByCode;
    cache.transactionByCustomer = transactionByCustomer;
    cache.customerStatsByCode = customerStatsByCode;
    cache.loaded = true;
    cache.loadedAt = new Date().toISOString();
    cache.errors = nextErrors;
  } catch (error) {
    cache.loaded = false;
    cache.errors = [error.message || 'Failed to load QuickBooks CSV data'];
    throw error;
  }

  return cache;
}

function buildCustomerResponse(customerCode) {
  loadDataIfNeeded();

  const normalizedCode = toUpperCode(customerCode);
  const customer = cache.customerByCode.get(normalizedCode);
  if (!customer) return null;

  const stats = cache.customerStatsByCode.get(normalizedCode) || calculateStats([]);

  return {
    ...customer,
    address: customer.invoiceToAddress || buildAddress(customer),
    currentQuickBooksBalance: customer.balance,
    analysis: {
      hasPurchasedBefore: stats.hasPurchasedBefore,
      totalInvoices: stats.invoiceCount,
      totalPayments: stats.paymentCount,
      totalAmountPurchased: stats.totalAmountPurchased,
      firstPurchaseDate: stats.firstPurchaseDate,
      lastPurchaseDate: stats.lastPurchaseDate,
      lifetimeValue: stats.lifetimeValue,
      yearsAsCustomer: stats.yearsAsCustomer,
      fraudIndicators: stats.fraudIndicators,
    },
    recentTransactions: stats.recentTransactions,
    transactionCount: stats.transactionCount,
  };
}

function queryCustomers({ query = '', field = 'all', limit = 20, page = 1, sortBy = 'customerName', sortOrder = 'asc' }) {
  loadDataIfNeeded();

  const cleanQuery = nonEmpty(query);
  const normalizedQuery = normalizeText(cleanQuery);
  const normalizedCodeQuery = normalizeCode(cleanQuery.replace(/^code\s*:\s*/i, ''));
  const normalizedPhone = normalizePhone(cleanQuery);
  const canUsePhoneMatch = isPhoneLikeQuery(cleanQuery);
  const normalizedField = nonEmpty(field).toLowerCase();
  const maxResults = Math.max(1, Math.min(Number(limit) || 20, 100));
  const currentPage = Math.max(1, Number(page) || 1);

  const baseRecords = cleanQuery
    ? cache.customerRecords.filter((customer) => {
    const byName = normalizeText(customer.customerName).includes(normalizedQuery);
    const byAddress = normalizeText(customer.invoiceToAddress || buildAddress(customer)).includes(normalizedQuery);
    const byEmail = normalizeText(customer.email).includes(normalizedQuery);
    const byPhone = canUsePhoneMatch && normalizedPhone && hasPhoneMatch(customer, normalizedPhone);
    const byCode = normalizedCodeQuery && normalizeCode(customer.customerCode).includes(normalizedCodeQuery);

    if (normalizedField === 'name') return byName;
    if (normalizedField === 'address') return byAddress;
    if (normalizedField === 'email') return byEmail;
    if (normalizedField === 'phone') {
      if (!normalizedPhone) return false;
      return hasPhoneMatch(customer, normalizedPhone);
    }
    if (normalizedField === 'code') return Boolean(byCode);

    return byName || byAddress || byEmail || Boolean(byPhone) || Boolean(byCode);
  })
    : [...cache.customerRecords];

  const sortField = nonEmpty(sortBy) || 'customerName';
  const direction = String(sortOrder).toLowerCase() === 'desc' ? -1 : 1;

  const enrichedRecords = baseRecords.map((customer) => {
    const stats = cache.customerStatsByCode.get(customer.customerCode) || calculateStats([]);

    return {
      customerCode: customer.customerCode,
      customerName: customer.customerName,
      email: customer.email,
      phone: customer.phone,
      address: customer.invoiceToAddress || buildAddress(customer),
      currentQuickBooksBalance: customer.balance,
      hasPurchasedBefore: stats.hasPurchasedBefore,
      totalInvoices: stats.invoiceCount,
      totalPayments: stats.paymentCount,
      totalAmountPurchased: stats.totalAmountPurchased,
      firstPurchaseDate: stats.firstPurchaseDate,
      lastPurchaseDate: stats.lastPurchaseDate,
      lifetimeValue: stats.lifetimeValue,
      yearsAsCustomer: stats.yearsAsCustomer,
      fraudIndicators: stats.fraudIndicators,
    };
  });

  const valueForSort = (record) => {
    switch (sortField) {
      case 'email':
        return normalizeText(record.email);
      case 'phone':
        return normalizePhone(record.phone);
      case 'totalInvoices':
        return Number(record.totalInvoices || 0);
      case 'totalPayments':
        return Number(record.totalPayments || 0);
      case 'lifetimeValue':
        return Number(record.lifetimeValue || 0);
      case 'address':
        return normalizeText(record.address);
      case 'customerCode':
        return normalizeText(record.customerCode);
      case 'customerName':
      default:
        return normalizeText(record.customerName || record.customerCode);
    }
  };

  const sortedRecords = enrichedRecords.sort((left, right) => {
    const leftValue = valueForSort(left);
    const rightValue = valueForSort(right);

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction;
    }

    if (leftValue > rightValue) return 1 * direction;
    if (leftValue < rightValue) return -1 * direction;
    return 0;
  });

  const total = sortedRecords.length;
  const start = (currentPage - 1) * maxResults;
  const pagedRecords = sortedRecords.slice(start, start + maxResults);

  return {
    total,
    page: currentPage,
    limit: maxResults,
    sortBy: sortField,
    sortOrder: direction === -1 ? 'desc' : 'asc',
    results: pagedRecords,
  };
}

function searchCustomers({ query, field = 'all', limit = 20 }) {
  return queryCustomers({ query, field, limit, page: 1 }).results;
}

function getQuickBooksLookupMeta() {
  loadDataIfNeeded();

  return {
    loadedAt: cache.loadedAt,
    customers: cache.customerRecords.length,
    transactionsGroupedCustomers: cache.transactionByCustomer.size,
    errors: cache.errors,
  };
}

module.exports = {
  loadDataIfNeeded,
  queryCustomers,
  searchCustomers,
  buildCustomerResponse,
  getQuickBooksLookupMeta,
};
