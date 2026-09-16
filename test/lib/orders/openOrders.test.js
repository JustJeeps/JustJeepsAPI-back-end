const test = require('node:test');
const assert = require('node:assert');

const {
	CLOSED_ORDER_STATUSES,
	buildPoNotSetOr,
	buildOpenOrdersWhere,
	normalizeEmail,
	normalizePhone,
	isSameCustomer,
	fetchOpenOrders,
	attachOpenOrdersSameCustomer,
} = require('../../../lib/orders/openOrders.js');

// Feature: "N OPEN ORDERS" tag on the Orders screen (asked by the purchasing
// team, 2026-09-15). Same customer = same email OR same phone (2026-09-16).
// The prisma client is injected: the local .env points at production Postgres.

// Snapshot of the array that lived inline in server.js (poStatus filters).
// If this changes, the not_set / not_set_4days filters change too.
const EXPECTED_PO_NOT_SET_OR = [
	{ custom_po_number: null },
	{ custom_po_number: '' },
	{ custom_po_number: { equals: 'not set', mode: 'insensitive' } },
	{
		AND: [
			{ custom_po_number: { contains: 'not set', mode: 'insensitive' } },
			{ NOT: { custom_po_number: { contains: 'pm', mode: 'insensitive' } } },
			{ NOT: { custom_po_number: { contains: 'kd', mode: 'insensitive' } } },
			{ NOT: { custom_po_number: { contains: 'jd', mode: 'insensitive' } } },
			{ NOT: { custom_po_number: { contains: 'jk', mode: 'insensitive' } } },
			{ NOT: { custom_po_number: { contains: 'affirm', mode: 'insensitive' } } },
			{ NOT: { custom_po_number: { contains: 'emt', mode: 'insensitive' } } },
		],
	},
];

const makePrismaStub = (rows = []) => {
	const calls = { findMany: [] };
	return {
		calls,
		order: {
			findMany: async (args) => {
				calls.findMany.push(args);
				return rows;
			},
		},
	};
};

const open = (entity_id, increment_id, customer_email, shipping_telephone, created_at = '2026-09-14 10:00:00') =>
	({ entity_id, increment_id, customer_email, shipping_telephone, created_at });

test('CLOSED_ORDER_STATUSES lists the three Magento terminal statuses', () => {
	assert.deepStrictEqual(CLOSED_ORDER_STATUSES, ['complete', 'closed', 'canceled']);
});

test('buildPoNotSetOr matches the array that server.js used inline', () => {
	assert.deepStrictEqual(buildPoNotSetOr(), EXPECTED_PO_NOT_SET_OR);
});

test('buildPoNotSetOr returns a fresh array each call (callers spread it into where.AND)', () => {
	assert.notStrictEqual(buildPoNotSetOr(), buildPoNotSetOr());
});

// Open = status not closed, regardless of the PO (decided 2026-09-16: with the
// PO condition only 21 orders were open in the whole store and the tag never
// showed). The PO rule stays exported for the poStatus filters only.
test('buildOpenOrdersWhere: status null or not closed, no PO condition', () => {
	assert.deepStrictEqual(buildOpenOrdersWhere(), {
		OR: [{ status: null }, { status: { notIn: ['complete', 'closed', 'canceled'] } }],
	});
});

test('normalizeEmail lowercases and trims; empty becomes null', () => {
	assert.strictEqual(normalizeEmail('  Sarah.M@Example.com '), 'sarah.m@example.com');
	assert.strictEqual(normalizeEmail(''), null);
	assert.strictEqual(normalizeEmail(null), null);
});

test('normalizePhone keeps digits only, drops the North American leading 1, ignores short values', () => {
	assert.strictEqual(normalizePhone('(416) 555-0100'), '4165550100');
	assert.strictEqual(normalizePhone('+1 416 555 0100'), '4165550100');
	assert.strictEqual(normalizePhone('1-416-555-0100'), '4165550100');
	assert.strictEqual(normalizePhone('555-0100'), '5550100');
	assert.strictEqual(normalizePhone('12345'), null);
	assert.strictEqual(normalizePhone(''), null);
	assert.strictEqual(normalizePhone(null), null);
});

test('isSameCustomer matches on email (case-insensitive) or on phone (any format)', () => {
	const a = open(1, '1', 'A@x.com', '416-555-0100');
	assert.strictEqual(isSameCustomer(a, open(2, '2', 'a@x.com', null)), true);
	assert.strictEqual(isSameCustomer(a, open(3, '3', 'other@x.com', '(416) 555 0100')), true);
	assert.strictEqual(isSameCustomer(a, open(4, '4', 'other@x.com', '416-555-0199')), false);
	assert.strictEqual(isSameCustomer(open(5, '5', '', ''), open(6, '6', '', '')), false);
	assert.strictEqual(isSameCustomer(open(7, '7', null, '12345'), open(8, '8', null, '12345')), false);
});

test('fetchOpenOrders reads every open order through wrapWhere, newest first, with email and phone', async () => {
	const rows = [open(3, '200070900', 'a@x.com', '416-555-0100'), open(1, '200070846', 'b@x.com', null)];
	const prisma = makePrismaStub(rows);
	const wrapWhere = (w) => ({ AND: [w, { customer_email: { not: { contains: 'hidden' } } }] });

	const result = await fetchOpenOrders(prisma, wrapWhere);

	assert.deepStrictEqual(result, rows);
	const args = prisma.calls.findMany[0];
	assert.deepStrictEqual(args.where, wrapWhere(buildOpenOrdersWhere()));
	assert.deepStrictEqual(args.select, { entity_id: true, increment_id: true, created_at: true, customer_email: true, shipping_telephone: true });
	assert.deepStrictEqual(args.orderBy, { created_at: 'desc' });
});

test('fetchOpenOrders requires wrapWhere so no caller skips buildVisibleOrdersWhere', async () => {
	const prisma = makePrismaStub();
	await assert.rejects(() => fetchOpenOrders(prisma), TypeError);
	assert.strictEqual(prisma.calls.findMany.length, 0);
});

test('attachOpenOrdersSameCustomer lists the open orders sharing email or phone with each row, itself included', () => {
	const openOrders = [
		open(3, '200070900', 'sarah@x.com', '416-555-0100'),
		open(2, '200070850', 'other@x.com', '(416) 555-0100'), // same phone, other email
		open(1, '200070846', 'SARAH@x.com', null), // same email, other case
		open(9, '200070999', 'nobody@x.com', '905-555-0000'),
	];
	const orders = [
		{ entity_id: 3, customer_email: 'sarah@x.com', shipping_telephone: '416-555-0100' },
		{ entity_id: 50, customer_email: 'closed@x.com', shipping_telephone: '' },
		{ entity_id: 51, customer_email: null, shipping_telephone: null },
	];

	const result = attachOpenOrdersSameCustomer(orders, openOrders);

	assert.deepStrictEqual(result[0].open_orders_same_customer, [
		{ entity_id: 3, increment_id: '200070900', created_at: '2026-09-14 10:00:00' },
		{ entity_id: 2, increment_id: '200070850', created_at: '2026-09-14 10:00:00' },
		{ entity_id: 1, increment_id: '200070846', created_at: '2026-09-14 10:00:00' },
	]);
	assert.deepStrictEqual(result[1].open_orders_same_customer, []);
	assert.deepStrictEqual(result[2].open_orders_same_customer, []);
	assert.strictEqual(result[0].entity_id, 3);
});

test('attachOpenOrdersSameCustomer does not mutate the input orders', () => {
	const orders = [{ entity_id: 1, customer_email: 'a@x.com', shipping_telephone: null }];
	attachOpenOrdersSameCustomer(orders, [open(1, '1', 'a@x.com', null)]);
	assert.strictEqual('open_orders_same_customer' in orders[0], false);
});
