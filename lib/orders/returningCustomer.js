// "Returning customer" flag on the Orders screen (purchasing team, 2026-09-29).
//
// Before buying for an order the team searches the customer in QuickBooks and
// checks whether e-mail, phone, name and address match someone who already
// paid. This module does that check for a page of orders against the current
// QuickBooks import (services/quickbooksCustomerLookup.js keeps one snapshot,
// the newest import with status "complete").
//
// Rules (agreed with Ricardo):
// - A QuickBooks customer is a candidate when the order's e-mail OR phone
//   matches, and only when it has paid before (hasPurchasedBefore). Name and
//   address never anchor; they only count for the match percentage.
// - Four fields, 25% each: e-mail, phone, name, address. Each is "match",
//   "different" (both sides have data and disagree) or "missing".
// - Several candidates: best percentage wins, then the latest purchase.
//
// The prisma client is injected: the local .env points at production Postgres.
// Phones are matched through phoneSortDigits (indexed by importId) with both
// the 10 and the 11 digit forms in the list. phoneSearch (phones typed inside
// the "Invoice to" block) is only consulted in memory for the score: a LIKE
// per variant on it would scan the whole import on every page load. If the
// team reports misses, a bounded second query for the orders left without a
// candidate can be added without changing the response shape.

const { normalizeEmail, normalizePhone } = require('./openOrders');
const { normalizePhoneVariants } = require('../../services/quickbooksCustomerData');

const FIELDS = ['email', 'phone', 'name', 'address'];
const QB_NO_NAME_LITERAL = 'no first and last name on db';

const CANDIDATE_SELECT = Object.freeze({
	customerCode: true,
	firstName: true,
	lastName: true,
	companyName: true,
	displayName: true,
	searchName: true,
	email: true,
	emailNorm: true,
	phone: true,
	phoneSortDigits: true,
	phoneSearch: true,
	street1: true,
	city: true,
	postalCode: true,
	lastPurchaseDate: true,
	lastPurchaseSortAt: true,
	paymentCount: true,
});

const text = (value) => String(value ?? '').trim();

const buildOrderIdentity = (order) => {
	const email = normalizeEmail(order?.customer_email);
	const phone = normalizePhone(order?.shipping_telephone);
	return { email, phone, phoneVariants: phone ? normalizePhoneVariants(phone) : [] };
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const buildCandidatesWhere = (importId, orders) => {
	const identities = orders.map(buildOrderIdentity);
	const emails = unique(identities.map((id) => id.email));
	const phones = unique(identities.flatMap((id) => id.phoneVariants));
	const or = [];
	if (emails.length) or.push({ emailNorm: { in: emails } });
	if (phones.length) or.push({ phoneSortDigits: { in: phones } });
	if (!or.length) return null;
	return { importId, hasPurchasedBefore: true, OR: or };
};

const fetchReturningCustomerCandidates = async (prisma, orders) => {
	if (!orders.length) return null;
	const current = await prisma.quickBooksImport.findFirst({
		where: { status: 'complete' },
		orderBy: { id: 'desc' },
		select: { id: true, sourceExportedAt: true },
	});
	if (!current) return null;
	const where = buildCandidatesWhere(current.id, orders);
	if (!where) return { importId: current.id, sourceExportedAt: current.sourceExportedAt, customers: [] };
	const customers = await prisma.quickBooksCustomer.findMany({ where, select: CANDIDATE_SELECT });
	return { importId: current.id, sourceExportedAt: current.sourceExportedAt, customers };
};

// ---- normalizers (pure) ----------------------------------------------------

const normalizeName = (value) => text(value)
	.normalize('NFD')
	.replace(/[̀-ͯ]/g, '')
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, ' ')
	.trim()
	.replace(/\s+/g, ' ');

const nameTokens = (value) => normalizeName(value).split(' ').filter(Boolean).sort().join(' ');

const normalizePostcode = (value) => {
	const code = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
	// US ZIP+4: compare the five digit part only.
	return /^\d{9}$/.test(code) ? code.slice(0, 5) : code;
};

const STREET_SUFFIXES = {
	street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
	apartment: 'apt', suite: 'unit',
};

const normalizeStreet = (value) => normalizeName(value)
	.split(' ')
	.map((word) => STREET_SUFFIXES[word] || word)
	.join(' ');

// ---- scoring (pure) --------------------------------------------------------

const compareEmail = (identity, qb) => {
	const theirs = text(qb.emailNorm).toLowerCase();
	if (!identity.email || !theirs) return 'missing';
	return identity.email === theirs ? 'match' : 'different';
};

const comparePhone = (identity, qb) => {
	const sortDigits = text(qb.phoneSortDigits);
	const searchDigits = text(qb.phoneSearch).split(/\s+/).filter(Boolean);
	if (!identity.phone || (!sortDigits && !searchDigits.length)) return 'missing';
	const theirs = new Set([sortDigits, ...searchDigits].filter(Boolean));
	return identity.phoneVariants.some((variant) => theirs.has(variant)) ? 'match' : 'different';
};

const orderName = (order) => `${text(order?.customer_firstname)} ${text(order?.customer_lastname)}`.trim();

const qbNameCandidates = (qb) => {
	const names = [`${text(qb.firstName)} ${text(qb.lastName)}`.trim(), text(qb.companyName)];
	const display = text(qb.displayName);
	if (display && display !== text(qb.street1) && display.toLowerCase() !== QB_NO_NAME_LITERAL) names.push(display);
	const search = text(qb.searchName);
	if (search && search !== text(qb.customerCode)) names.push(search);
	return unique(names.map(nameTokens));
};

const compareName = (order, qb) => {
	const mine = nameTokens(orderName(order));
	const theirs = qbNameCandidates(qb);
	if (!mine || !theirs.length) return 'missing';
	return theirs.includes(mine) ? 'match' : 'different';
};

const orderAddress = (order) => {
	const shipping = { street: text(order?.shipping_street1), city: text(order?.shipping_city), postcode: text(order?.shipping_postcode) };
	if (shipping.postcode) return shipping;
	const billing = { street: text(order?.billing_street), city: text(order?.billing_city), postcode: text(order?.billing_postcode) };
	if (billing.postcode || billing.street || billing.city) return billing;
	return shipping;
};

const qbAddress = (qb) => ({ street: text(qb.street1), city: text(qb.city), postcode: text(qb.postalCode) });

const hasAddress = (address) => Boolean(address.postcode || address.street || address.city);

const compareAddress = (mine, theirs) => {
	if (!hasAddress(mine) || !hasAddress(theirs)) return 'missing';
	const samePostcode = normalizePostcode(mine.postcode) === normalizePostcode(theirs.postcode);
	const sameStreet = normalizeStreet(mine.street) && normalizeStreet(mine.street) === normalizeStreet(theirs.street);
	const sameCity = normalizeName(mine.city) && normalizeName(mine.city) === normalizeName(theirs.city);
	return samePostcode && (sameStreet || sameCity) ? 'match' : 'different';
};

const formatAddress = (address) => {
	const place = [address.city, address.postcode].filter(Boolean).join(' ');
	return [address.street, place].filter(Boolean).join(', ');
};

// Name shown in the tooltip: first + last, else the company, else the display
// name when it is a real name (not the street or the "no name" literal).
const qbDisplayName = (qb) => {
	const full = `${text(qb.firstName)} ${text(qb.lastName)}`.trim();
	if (full) return full;
	if (text(qb.companyName)) return text(qb.companyName);
	return qbNameCandidates(qb).length ? text(qb.displayName) : '';
};

const scoreReturningCustomer = (order, qb) => {
	const identity = buildOrderIdentity(order);
	const mine = orderAddress(order);
	const theirs = qbAddress(qb);
	const fields = {
		email: compareEmail(identity, qb),
		phone: comparePhone(identity, qb),
		name: compareName(order, qb),
		address: compareAddress(mine, theirs),
	};
	const matches = FIELDS.filter((field) => fields[field] === 'match').length;
	const values = {
		email: { order: text(order?.customer_email), quickbooks: text(qb.email) },
		phone: { order: text(order?.shipping_telephone), quickbooks: text(qb.phone) },
		name: { order: orderName(order), quickbooks: qbDisplayName(qb) },
		address: { order: formatAddress(mine), quickbooks: formatAddress(theirs) },
	};
	return { percent: Math.round((matches / FIELDS.length) * 100), fields, values };
};

const anchorsOn = (identity, qb) => {
	if (identity.email && identity.email === text(qb.emailNorm).toLowerCase()) return true;
	const sortDigits = text(qb.phoneSortDigits);
	return Boolean(sortDigits) && identity.phoneVariants.includes(sortDigits);
};

const timeOf = (value) => {
	const ms = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
	return Number.isFinite(ms) ? ms : 0;
};

const pickBestCandidate = (order, customers) => {
	const identity = buildOrderIdentity(order);
	const scored = (customers || [])
		.filter((qb) => anchorsOn(identity, qb))
		.map((qb) => ({ customer: qb, score: scoreReturningCustomer(order, qb) }));
	if (!scored.length) return null;
	scored.sort((a, b) =>
		b.score.percent - a.score.percent
		|| timeOf(b.customer.lastPurchaseSortAt) - timeOf(a.customer.lastPurchaseSortAt)
		|| text(a.customer.customerCode).localeCompare(text(b.customer.customerCode)));
	return scored[0];
};

const toIso = (value) => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const attachReturningCustomer = (orders, candidates) =>
	orders.map((order) => {
		const best = candidates ? pickBestCandidate(order, candidates.customers) : null;
		return {
			...order,
			returning_customer: best
				? {
					customer_code: best.customer.customerCode,
					customer_name: best.score.values.name.quickbooks,
					percent: best.score.percent,
					fields: best.score.fields,
					values: best.score.values,
					last_purchase_date: best.customer.lastPurchaseDate || null,
					payment_count: best.customer.paymentCount ?? null,
					snapshot_exported_at: toIso(candidates.sourceExportedAt),
				}
				: null,
		};
	});

// Safe wrapper for GET /api/orders: the Orders list must never fail because
// of this flag. csv mode has no QuickBooks tables; any error is logged once
// per request and every row gets null.
const loadReturningCustomerCandidates = async (prisma, orders, { isDbSource, logger }) => {
	if (typeof isDbSource === 'function' && !isDbSource()) return null;
	try {
		return await fetchReturningCustomerCandidates(prisma, orders);
	} catch (error) {
		logger.error('Returning customer lookup failed; Orders served without the flag', {
			error: error.message,
			code: error.code || null,
		});
		return null;
	}
};

module.exports = {
	CANDIDATE_SELECT,
	buildOrderIdentity,
	buildCandidatesWhere,
	fetchReturningCustomerCandidates,
	normalizeName,
	nameTokens,
	normalizePostcode,
	normalizeStreet,
	scoreReturningCustomer,
	pickBestCandidate,
	attachReturningCustomer,
	loadReturningCustomerCandidates,
};
