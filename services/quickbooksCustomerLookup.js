const path = require('path');
const prisma = require('../lib/prisma');
const {
  nonEmpty,
  normalizeText,
  normalizePhone,
  normalizePhoneVariants,
  hasPhoneMatch,
  isPhoneLikeQuery,
  normalizeCode,
  toUpperCode,
  escapeLikePattern,
  buildAddress,
  getPreferredCustomerName,
  computeYearsAsCustomer,
  buildFraudIndicators,
  calculateStats,
  loadCustomers,
  loadTransactions,
  buildSearchResultFromRow,
  buildDetailResponseFromRow,
} = require('./quickbooksCustomerData');

// Diretorio dos CSVs: configuravel porque o path legado tem espaco no nome, o
// que quebra o volume mount do Kamal (docker run sem quoting). Em producao,
// QB_LOOKUP_DATA_DIR aponta para /data/quickbooks-customers (volume inbox).
const QB_LOOKUP_DATA_DIR = process.env.QB_LOOKUP_DATA_DIR
  || path.resolve(__dirname, '..', 'QuickBooks Project', 'customers');

const CUSTOMER_CSV_PATH = path.join(QB_LOOKUP_DATA_DIR, 'customers_qb_desktop.csv');
const TRANSACTION_CSV_PATH = path.join(QB_LOOKUP_DATA_DIR, 'transactions_per_customer.csv');

// Fonte dos dados: 'csv' (cache em memoria, legado) ou 'db' (Postgres,
// populado pelo seed-quickbooks-customers). Lido a cada chamada para permitir
// flip sem rebuild.
function isDbSource() {
  return String(process.env.QB_LOOKUP_SOURCE || 'csv').toLowerCase() === 'db';
}

// ---------------------------------------------------------------------------
// Modo csv (legado): cache em memoria carregado dos CSVs.
// ---------------------------------------------------------------------------

const cache = {
  loaded: false,
  loadedAt: null,
  customerRecords: [],
  customerByCode: new Map(),
  transactionByCustomer: new Map(),
  customerStatsByCode: new Map(),
  errors: [],
};

function loadDataIfNeeded({ forceReload = false } = {}) {
  if (isDbSource()) {
    return cache;
  }

  if (cache.loaded && !forceReload) {
    return cache;
  }

  const nextErrors = [];

  try {
    const customerRecords = loadCustomers(CUSTOMER_CSV_PATH);
    const transactionByCustomer = loadTransactions(TRANSACTION_CSV_PATH);
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

function buildCustomerResponseCsv(customerCode) {
  loadDataIfNeeded();

  const normalizedCode = toUpperCode(customerCode);
  const customer = cache.customerByCode.get(normalizedCode);
  if (!customer) return null;

  const stats = cache.customerStatsByCode.get(normalizedCode) || calculateStats([]);

  return {
    ...customer,
    customerName: getPreferredCustomerName(customer),
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

function queryCustomersCsv({ query = '', field = 'all', limit = 20, page = 1, sortBy = 'customerName', sortOrder = 'asc' }) {
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
      customerName: getPreferredCustomerName(customer),
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
      case 'lastPurchaseDate': {
        const dateValue = Date.parse(record.lastPurchaseDate || '');
        return Number.isFinite(dateValue) ? dateValue : 0;
      }
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

function getQuickBooksLookupMetaCsv() {
  loadDataIfNeeded();

  return {
    loadedAt: cache.loadedAt,
    customers: cache.customerRecords.length,
    transactionsGroupedCustomers: cache.transactionByCustomer.size,
    errors: cache.errors,
  };
}

// ---------------------------------------------------------------------------
// Modo db: consultas ao Postgres (snapshot corrente = ultimo import complete).
// ---------------------------------------------------------------------------

const SORT_COLUMN_BY_FIELD = {
  customerName: 'displayNameNorm',
  email: 'emailNorm',
  phone: 'phoneSortDigits',
  lastPurchaseDate: 'lastPurchaseSortAt',
  totalInvoices: 'invoiceCount',
  totalPayments: 'paymentCount',
  lifetimeValue: 'lifetimeValue',
  address: 'addressNorm',
  customerCode: 'codeSort',
};

async function getCurrentImportId() {
  const current = await prisma.quickBooksImport.findFirst({
    where: { status: 'complete' },
    orderBy: { id: 'desc' },
    select: { id: true },
  });

  return current ? current.id : null;
}

function emptyPage({ page, limit, sortField, direction }) {
  return {
    total: 0,
    page,
    limit,
    sortBy: sortField,
    sortOrder: direction === -1 ? 'desc' : 'asc',
    results: [],
  };
}

async function queryCustomersDb({ query = '', field = 'all', limit = 20, page = 1, sortBy = 'customerName', sortOrder = 'asc' }) {
  const cleanQuery = nonEmpty(query);
  const normalizedQuery = normalizeText(cleanQuery);
  const normalizedCodeQuery = normalizeCode(cleanQuery.replace(/^code\s*:\s*/i, ''));
  const normalizedPhone = normalizePhone(cleanQuery);
  const canUsePhoneMatch = isPhoneLikeQuery(cleanQuery);
  const normalizedField = nonEmpty(field).toLowerCase();
  const maxResults = Math.max(1, Math.min(Number(limit) || 20, 100));
  const currentPage = Math.max(1, Number(page) || 1);
  const sortField = nonEmpty(sortBy) || 'customerName';
  const direction = String(sortOrder).toLowerCase() === 'desc' ? -1 : 1;
  const pageShape = { page: currentPage, limit: maxResults, sortField, direction };

  const importId = await getCurrentImportId();
  if (importId === null) {
    return emptyPage(pageShape);
  }

  const where = { importId };

  if (cleanQuery) {
    // codeNorm e variantes de telefone sao alfanumericos puros; apenas o texto
    // livre precisa de escape de metacaracteres LIKE.
    const likeQuery = escapeLikePattern(normalizedQuery);
    const phoneVariantFilters = normalizePhoneVariants(normalizedPhone)
      .map((variant) => ({ phoneSearch: { contains: variant } }));

    if (normalizedField === 'name') {
      where.searchNameNorm = { contains: likeQuery };
    } else if (normalizedField === 'address') {
      where.addressNorm = { contains: likeQuery };
    } else if (normalizedField === 'email') {
      where.emailNorm = { contains: likeQuery };
    } else if (normalizedField === 'phone') {
      if (!normalizedPhone || !phoneVariantFilters.length) {
        return emptyPage(pageShape);
      }
      where.OR = phoneVariantFilters;
    } else if (normalizedField === 'code') {
      if (!normalizedCodeQuery) {
        return emptyPage(pageShape);
      }
      where.codeNorm = { contains: normalizedCodeQuery };
    } else {
      const or = [
        { searchNameNorm: { contains: likeQuery } },
        { addressNorm: { contains: likeQuery } },
        { emailNorm: { contains: likeQuery } },
      ];
      if (canUsePhoneMatch && normalizedPhone) {
        or.push(...phoneVariantFilters);
      }
      if (normalizedCodeQuery) {
        or.push({ codeNorm: { contains: normalizedCodeQuery } });
      }
      where.OR = or;
    }
  }

  const sortColumn = SORT_COLUMN_BY_FIELD[sortField] || 'displayNameNorm';
  const orderBy = [
    { [sortColumn]: direction === -1 ? 'desc' : 'asc' },
    { customerCode: 'asc' },
  ];

  const [rows, total] = await Promise.all([
    prisma.quickBooksCustomer.findMany({
      where,
      orderBy,
      skip: (currentPage - 1) * maxResults,
      take: maxResults,
    }),
    prisma.quickBooksCustomer.count({ where }),
  ]);

  return {
    total,
    page: currentPage,
    limit: maxResults,
    sortBy: sortField,
    sortOrder: direction === -1 ? 'desc' : 'asc',
    results: rows.map(buildSearchResultFromRow),
  };
}

async function buildCustomerResponseDb(customerCode) {
  const importId = await getCurrentImportId();
  if (importId === null) return null;

  const row = await prisma.quickBooksCustomer.findUnique({
    where: {
      importId_customerCode: {
        importId,
        customerCode: toUpperCode(customerCode),
      },
    },
  });

  if (!row) return null;

  return buildDetailResponseFromRow(row);
}

async function getQuickBooksLookupMetaDb() {
  const current = await prisma.quickBooksImport.findFirst({
    where: { status: 'complete' },
    orderBy: { id: 'desc' },
  });

  if (!current) {
    return {
      loadedAt: null,
      customers: 0,
      transactionsGroupedCustomers: 0,
      errors: ['No QuickBooks import found'],
      lastImportAt: null,
      sourceExportedAt: null,
      ageDays: null,
    };
  }

  const freshnessReference = current.sourceExportedAt || current.importedAt;
  const ageDays = Number(((Date.now() - freshnessReference.getTime()) / 86400000).toFixed(1));

  return {
    loadedAt: current.importedAt.toISOString(),
    customers: current.customers,
    transactionsGroupedCustomers: current.transactionsGroupedCustomers,
    errors: current.errors || [],
    lastImportAt: current.importedAt.toISOString(),
    sourceExportedAt: current.sourceExportedAt ? current.sourceExportedAt.toISOString() : null,
    ageDays,
  };
}

// ---------------------------------------------------------------------------
// API publica (nomes preservados; handlers do server.js fazem await, que
// funciona tanto para os retornos sincronos do csv quanto para as Promises do db).
// ---------------------------------------------------------------------------

function queryCustomers(params) {
  return isDbSource() ? queryCustomersDb(params) : queryCustomersCsv(params);
}

async function searchCustomers({ query, field = 'all', limit = 20 }) {
  const payload = await queryCustomers({ query, field, limit, page: 1 });
  return payload.results;
}

function buildCustomerResponse(customerCode) {
  return isDbSource() ? buildCustomerResponseDb(customerCode) : buildCustomerResponseCsv(customerCode);
}

function getQuickBooksLookupMeta() {
  return isDbSource() ? getQuickBooksLookupMetaDb() : getQuickBooksLookupMetaCsv();
}

module.exports = {
  loadDataIfNeeded,
  queryCustomers,
  searchCustomers,
  buildCustomerResponse,
  getQuickBooksLookupMeta,
  isDbSource,
  CUSTOMER_CSV_PATH,
  TRANSACTION_CSV_PATH,
};
