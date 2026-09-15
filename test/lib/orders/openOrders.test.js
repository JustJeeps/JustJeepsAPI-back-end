const test = require('node:test');
const assert = require('node:assert');

const {
	CLOSED_ORDER_STATUSES,
	buildPoNotSetOr,
	buildOpenOrdersWhere,
	fetchOpenOrdersByCustomer,
	attachOpenOrdersSameCustomer,
} = require('../../../lib/orders/openOrders.js');

// Feature: "N OPEN ORDERS" tag on the Orders screen (asked by the purchasing
// team, 2026-09-15). "Open" = PO still not set AND Magento status not closed.
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

test('CLOSED_ORDER_STATUSES lists the three Magento terminal statuses', () => {
	assert.deepStrictEqual(CLOSED_ORDER_STATUSES, ['complete', 'closed', 'canceled']);
});

test('buildPoNotSetOr matches the array that server.js used inline', () => {
	assert.deepStrictEqual(buildPoNotSetOr(), EXPECTED_PO_NOT_SET_OR);
});

test('buildPoNotSetOr returns a fresh array each call (callers spread it into where.AND)', () => {
	assert.notStrictEqual(buildPoNotSetOr(), buildPoNotSetOr());
});

test('buildOpenOrdersWhere restricts to the emails, PO not set, and status null or not closed', () => {
	const where = buildOpenOrdersWhere(['a@x.com', 'b@x.com']);
	assert.deepStrictEqual(where, {
		AND: [
			{ customer_email: { in: ['a@x.com', 'b@x.com'] } },
			{ OR: EXPECTED_PO_NOT_SET_OR },
			{ OR: [{ status: null }, { status: { notIn: ['complete', 'closed', 'canceled'] } }] },
		],
	});
});

test('fetchOpenOrdersByCustomer skips the query when there are no emails', async () => {
	const prisma = makePrismaStub();
	const result = await fetchOpenOrdersByCustomer(prisma, [], (w) => w);
	assert.deepStrictEqual(result, {});
	assert.strictEqual(prisma.calls.findMany.length, 0);
});

test('fetchOpenOrdersByCustomer groups open orders by email, newest first, through wrapWhere', async () => {
	const prisma = makePrismaStub([
		{ entity_id: 3, increment_id: '200070900', created_at: '2026-09-14 10:00:00', customer_email: 'a@x.com' },
		{ entity_id: 1, increment_id: '200070846', created_at: '2026-09-10 10:00:00', customer_email: 'a@x.com' },
		{ entity_id: 2, increment_id: '200070850', created_at: '2026-09-11 10:00:00', customer_email: 'b@x.com' },
	]);
	const wrapWhere = (w) => ({ AND: [...w.AND, { customer_email: { not: { contains: 'hidden' } } }] });

	const result = await fetchOpenOrdersByCustomer(prisma, ['a@x.com', 'b@x.com'], wrapWhere);

	assert.deepStrictEqual(result, {
		'a@x.com': [
			{ entity_id: 3, increment_id: '200070900', created_at: '2026-09-14 10:00:00' },
			{ entity_id: 1, increment_id: '200070846', created_at: '2026-09-10 10:00:00' },
		],
		'b@x.com': [
			{ entity_id: 2, increment_id: '200070850', created_at: '2026-09-11 10:00:00' },
		],
	});

	const args = prisma.calls.findMany[0];
	assert.deepStrictEqual(args.where, wrapWhere(buildOpenOrdersWhere(['a@x.com', 'b@x.com'])));
	assert.deepStrictEqual(args.select, { entity_id: true, increment_id: true, created_at: true, customer_email: true });
	assert.deepStrictEqual(args.orderBy, { created_at: 'desc' });
});

test('attachOpenOrdersSameCustomer adds the list per order and [] when the customer has none', () => {
	const orders = [
		{ entity_id: 1, customer_email: 'a@x.com' },
		{ entity_id: 9, customer_email: 'nobody@x.com' },
		{ entity_id: 7, customer_email: null },
	];
	const byEmail = { 'a@x.com': [{ entity_id: 1 }, { entity_id: 3 }] };

	const result = attachOpenOrdersSameCustomer(orders, byEmail);

	assert.deepStrictEqual(result.map((o) => o.open_orders_same_customer), [
		[{ entity_id: 1 }, { entity_id: 3 }],
		[],
		[],
	]);
	assert.strictEqual(result[0].entity_id, 1);
});

test('attachOpenOrdersSameCustomer does not mutate the input orders', () => {
	const orders = [{ entity_id: 1, customer_email: 'a@x.com' }];
	attachOpenOrdersSameCustomer(orders, { 'a@x.com': [{ entity_id: 1 }] });
	assert.strictEqual('open_orders_same_customer' in orders[0], false);
});
