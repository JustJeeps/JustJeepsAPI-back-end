const test = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../../../lib/orders/returningCustomer.js');

// Feature: blue "Returning customer" check next to the customer name on the
// Orders screen (asked by the purchasing team, 2026-09-29). A QuickBooks
// customer is a candidate by e-mail OR phone and must have paid before; name
// and address only count for the match percentage. Prisma is injected: the
// local .env points at production Postgres.

const makePrismaStub = ({ importRow = null, customers = [], failWith = null } = {}) => {
	const calls = { findFirst: [], findMany: [] };
	return {
		calls,
		quickBooksImport: {
			findFirst: async (args) => {
				calls.findFirst.push(args);
				return importRow;
			},
		},
		quickBooksCustomer: {
			findMany: async (args) => {
				calls.findMany.push(args);
				if (failWith) throw failWith;
				return customers;
			},
		},
	};
};

const order = (overrides = {}) => ({
	entity_id: 1,
	increment_id: '200070001',
	customer_email: 'Marc.L@Example.com',
	customer_firstname: 'Marc',
	customer_lastname: 'Lavoie',
	shipping_telephone: '(416) 555-0199',
	shipping_street1: '12 Main Street',
	shipping_city: 'Toronto',
	shipping_postcode: 'M5V 3L9',
	billing_street: '',
	billing_city: '',
	billing_postcode: '',
	...overrides,
});

const qb = (overrides = {}) => ({
	customerCode: 'LAVOIEM',
	firstName: 'Marc',
	lastName: 'Lavoie',
	companyName: '',
	displayName: 'Marc Lavoie',
	searchName: 'Marc Lavoie',
	email: 'marc.l@example.com',
	emailNorm: 'marc.l@example.com',
	phone: '416-555-0199',
	phoneSortDigits: '4165550199',
	phoneSearch: '4165550199 14165550199',
	street1: '12 Main St',
	city: 'Toronto',
	postalCode: 'M5V3L9',
	lastPurchaseDate: '2026-03-14',
	lastPurchaseSortAt: new Date('2026-03-14T00:00:00Z'),
	paymentCount: 3,
	...overrides,
});

const quietLogger = () => {
	const lines = { error: [] };
	return { lines, error: (...args) => lines.error.push(args), warn() {}, info() {} };
};

test('buildOrderIdentity normalizes the e-mail and gives both phone variants', () => {
	assert.deepStrictEqual(buildOrderIdentity(order()), {
		email: 'marc.l@example.com',
		phone: '4165550199',
		phoneVariants: ['4165550199', '14165550199'],
	});
	assert.deepStrictEqual(buildOrderIdentity(order({ customer_email: '', shipping_telephone: '12345' })), {
		email: null,
		phone: null,
		phoneVariants: [],
	});
});

test('buildCandidatesWhere anchors on e-mail or phone, paid customers of the current import only', () => {
	const where = buildCandidatesWhere(7, [order(), order({ customer_email: 'B@x.com', shipping_telephone: '' })]);
	assert.deepStrictEqual(where, {
		importId: 7,
		hasPurchasedBefore: true,
		OR: [
			{ emailNorm: { in: ['marc.l@example.com', 'b@x.com'] } },
			{ phoneSortDigits: { in: ['4165550199', '14165550199'] } },
		],
	});
});

test('buildCandidatesWhere drops an empty OR entry and is null when nothing anchors', () => {
	const emailOnly = buildCandidatesWhere(7, [order({ shipping_telephone: '' })]);
	assert.deepStrictEqual(emailOnly.OR, [{ emailNorm: { in: ['marc.l@example.com'] } }]);
	const phoneOnly = buildCandidatesWhere(7, [order({ customer_email: '' })]);
	assert.deepStrictEqual(phoneOnly.OR, [{ phoneSortDigits: { in: ['4165550199', '14165550199'] } }]);
	assert.strictEqual(buildCandidatesWhere(7, [order({ customer_email: '', shipping_telephone: '' })]), null);
});

test('CANDIDATE_SELECT never loads the recent transactions json', () => {
	assert.strictEqual(CANDIDATE_SELECT.recentTransactions, undefined);
	assert.strictEqual(CANDIDATE_SELECT.customerCode, true);
	assert.strictEqual(CANDIDATE_SELECT.phoneSearch, true);
});

test('fetchReturningCustomerCandidates makes no query without orders', async () => {
	const prisma = makePrismaStub();
	assert.strictEqual(await fetchReturningCustomerCandidates(prisma, []), null);
	assert.strictEqual(prisma.calls.findFirst.length, 0);
});

test('fetchReturningCustomerCandidates is null without a complete import and never queries customers', async () => {
	const prisma = makePrismaStub({ importRow: null });
	assert.strictEqual(await fetchReturningCustomerCandidates(prisma, [order()]), null);
	assert.deepStrictEqual(prisma.calls.findFirst[0], {
		where: { status: 'complete' },
		orderBy: { id: 'desc' },
		select: { id: true, sourceExportedAt: true },
	});
	assert.strictEqual(prisma.calls.findMany.length, 0);
});

test('fetchReturningCustomerCandidates queries the current import with the candidate select', async () => {
	const exportedAt = new Date('2026-07-16T12:00:00Z');
	const prisma = makePrismaStub({ importRow: { id: 9, sourceExportedAt: exportedAt }, customers: [qb()] });
	const result = await fetchReturningCustomerCandidates(prisma, [order()]);
	assert.strictEqual(result.importId, 9);
	assert.strictEqual(result.sourceExportedAt, exportedAt);
	assert.strictEqual(result.customers.length, 1);
	assert.strictEqual(prisma.calls.findMany[0].where.importId, 9);
	assert.deepStrictEqual(prisma.calls.findMany[0].select, CANDIDATE_SELECT);
});

test('fetchReturningCustomerCandidates skips the customer query when nothing anchors', async () => {
	const prisma = makePrismaStub({ importRow: { id: 9, sourceExportedAt: null } });
	const result = await fetchReturningCustomerCandidates(prisma, [order({ customer_email: '', shipping_telephone: '' })]);
	assert.deepStrictEqual(result, { importId: 9, sourceExportedAt: null, customers: [] });
	assert.strictEqual(prisma.calls.findMany.length, 0);
});

test('normalizers ignore accents, case, order of names, postcode spacing and street suffixes', () => {
	assert.strictEqual(normalizeName('  José  Álvarez-Núñez '), 'jose alvarez nunez');
	assert.strictEqual(nameTokens('Lavoie Marc'), nameTokens('Marc Lavoie'));
	assert.strictEqual(normalizePostcode('m5v 3l9'), 'M5V3L9');
	assert.strictEqual(normalizePostcode('90210-1234'), '90210');
	assert.strictEqual(normalizeStreet('12 Main Street'), normalizeStreet('12 main st.'));
	assert.strictEqual(normalizeStreet('5 Oak Avenue, Apartment 3'), normalizeStreet('5 Oak Ave Apt 3'));
});

test('scoreReturningCustomer is 100% when every field matches', () => {
	const score = scoreReturningCustomer(order(), qb());
	assert.strictEqual(score.percent, 100);
	assert.deepStrictEqual(score.fields, { email: 'match', phone: 'match', name: 'match', address: 'match' });
	assert.deepStrictEqual(score.values.phone, { order: '(416) 555-0199', quickbooks: '416-555-0199' });
	assert.deepStrictEqual(score.values.address, { order: '12 Main Street, Toronto M5V 3L9', quickbooks: '12 Main St, Toronto M5V3L9' });
});

test('scoreReturningCustomer marks a differing phone and a missing address', () => {
	const score = scoreReturningCustomer(order(), qb({ phone: '647-555-0000', phoneSortDigits: '6475550000', phoneSearch: '6475550000 16475550000', street1: '', city: '', postalCode: '' }));
	assert.strictEqual(score.percent, 50);
	assert.strictEqual(score.fields.phone, 'different');
	assert.strictEqual(score.fields.address, 'missing');
	assert.deepStrictEqual(score.values.address, { order: '12 Main Street, Toronto M5V 3L9', quickbooks: '' });
});

test('scoreReturningCustomer accepts a phone found only in the Invoice-to text and the 11 digit form', () => {
	const score = scoreReturningCustomer(order(), qb({ phoneSortDigits: '', phoneSearch: '14165550199' }));
	assert.strictEqual(score.fields.phone, 'match');
	const eleven = scoreReturningCustomer(order(), qb({ phoneSortDigits: '14165550199', phoneSearch: '' }));
	assert.strictEqual(eleven.fields.phone, 'match');
});

test('scoreReturningCustomer treats the QuickBooks fallback names as missing, and a company name as a name', () => {
	const fallback = scoreReturningCustomer(order(), qb({ firstName: '', lastName: '', companyName: '', displayName: '12 Main St', searchName: 'LAVOIEM' }));
	assert.strictEqual(fallback.fields.name, 'missing');
	const literal = scoreReturningCustomer(order(), qb({ firstName: '', lastName: '', companyName: '', displayName: 'no first and last name on db', searchName: 'LAVOIEM' }));
	assert.strictEqual(literal.fields.name, 'missing');
	const company = scoreReturningCustomer(order({ customer_firstname: 'Lavoie', customer_lastname: 'Auto Inc' }), qb({ firstName: '', lastName: '', companyName: 'Lavoie Auto Inc.', displayName: 'Lavoie Auto Inc.', searchName: 'Lavoie Auto Inc.' }));
	assert.strictEqual(company.fields.name, 'match');
	const different = scoreReturningCustomer(order({ customer_firstname: 'Anna', customer_lastname: 'Lavoie' }), qb());
	assert.strictEqual(different.fields.name, 'different');
});

test('scoreReturningCustomer falls back to the billing address when shipping has no postcode', () => {
	const billed = order({ shipping_street1: '', shipping_city: '', shipping_postcode: '', billing_street: '12 Main St', billing_city: 'Toronto', billing_postcode: 'M5V 3L9' });
	assert.strictEqual(scoreReturningCustomer(billed, qb()).fields.address, 'match');
	const elsewhere = order({ shipping_street1: '9 Elm Rd', shipping_city: 'Ottawa', shipping_postcode: 'K1A 0B1' });
	assert.strictEqual(scoreReturningCustomer(elsewhere, qb()).fields.address, 'different');
	const none = order({ shipping_street1: '', shipping_city: '', shipping_postcode: '' });
	assert.strictEqual(scoreReturningCustomer(none, qb()).fields.address, 'missing');
});

test('scoreReturningCustomer marks e-mail missing when the order has none', () => {
	const score = scoreReturningCustomer(order({ customer_email: '' }), qb());
	assert.strictEqual(score.fields.email, 'missing');
	assert.strictEqual(score.percent, 75);
});

test('pickBestCandidate keeps only customers that anchor on the order and prefers the best score, then the latest purchase', () => {
	const stranger = qb({ customerCode: 'OTHER', emailNorm: 'other@x.com', phoneSortDigits: '9055550000', phoneSearch: '9055550000' });
	const phoneOnly = qb({ customerCode: 'PHONE', emailNorm: 'old@x.com', email: 'old@x.com' });
	const full = qb({ customerCode: 'FULL' });
	const best = pickBestCandidate(order(), [stranger, phoneOnly, full]);
	assert.strictEqual(best.customer.customerCode, 'FULL');
	assert.strictEqual(best.score.percent, 100);
	assert.strictEqual(pickBestCandidate(order(), [stranger]), null);

	const older = qb({ customerCode: 'OLDER', lastPurchaseSortAt: new Date('2024-01-01T00:00:00Z') });
	const newer = qb({ customerCode: 'NEWER', lastPurchaseSortAt: new Date('2026-01-01T00:00:00Z') });
	assert.strictEqual(pickBestCandidate(order(), [older, newer]).customer.customerCode, 'NEWER');
});

test('pickBestCandidate scores a phone-only match with a different e-mail at 50%', () => {
	const phoneOnly = qb({ emailNorm: 'old@x.com', email: 'old@x.com', street1: '', city: '', postalCode: '' });
	const best = pickBestCandidate(order(), [phoneOnly]);
	assert.strictEqual(best.score.percent, 50);
	assert.strictEqual(best.score.fields.email, 'different');
});

test('attachReturningCustomer adds the flag without mutating the rows and yields null when there are no candidates', () => {
	const rows = [order(), order({ entity_id: 2, customer_email: 'nobody@x.com', shipping_telephone: '' })];
	const exportedAt = new Date('2026-07-16T12:00:00Z');
	const out = attachReturningCustomer(rows, { importId: 9, sourceExportedAt: exportedAt, customers: [qb()] });
	assert.strictEqual(rows[0].returning_customer, undefined);
	assert.deepStrictEqual(out[0].returning_customer, {
		customer_code: 'LAVOIEM',
		customer_name: 'Marc Lavoie',
		percent: 100,
		fields: { email: 'match', phone: 'match', name: 'match', address: 'match' },
		values: out[0].returning_customer.values,
		last_purchase_date: '2026-03-14',
		payment_count: 3,
		snapshot_exported_at: '2026-07-16T12:00:00.000Z',
	});
	assert.strictEqual(out[1].returning_customer, null);
	assert.deepStrictEqual(attachReturningCustomer(rows, null).map((row) => row.returning_customer), [null, null]);
});

test('loadReturningCustomerCandidates is null in csv mode without touching prisma', async () => {
	const prisma = makePrismaStub({ importRow: { id: 9, sourceExportedAt: null }, customers: [qb()] });
	const result = await loadReturningCustomerCandidates(prisma, [order()], { isDbSource: () => false, logger: quietLogger() });
	assert.strictEqual(result, null);
	assert.strictEqual(prisma.calls.findFirst.length, 0);
});

test('loadReturningCustomerCandidates logs and returns null when the query fails', async () => {
	const failure = Object.assign(new Error('relation does not exist'), { code: 'P2021' });
	const prisma = makePrismaStub({ importRow: { id: 9, sourceExportedAt: null }, failWith: failure });
	const logger = quietLogger();
	const result = await loadReturningCustomerCandidates(prisma, [order()], { isDbSource: () => true, logger });
	assert.strictEqual(result, null);
	assert.strictEqual(logger.lines.error.length, 1);
	assert.match(logger.lines.error[0][0], /Returning customer lookup failed/);
	assert.deepStrictEqual(logger.lines.error[0][1], { error: 'relation does not exist', code: 'P2021' });
});

test('loadReturningCustomerCandidates returns the candidates in db mode', async () => {
	const prisma = makePrismaStub({ importRow: { id: 9, sourceExportedAt: null }, customers: [qb()] });
	const result = await loadReturningCustomerCandidates(prisma, [order()], { isDbSource: () => true, logger: quietLogger() });
	assert.strictEqual(result.customers.length, 1);
});
