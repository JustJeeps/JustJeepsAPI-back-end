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

// Open is decided by OUR ship status only; Magento's status is ignored (decided
// 2026-09-23). The PO rule stays exported for the poStatus filters only. The SQL
// is a pre-filter; isOpenOrder is the rule.
test('buildOpenOrdersWhere: ship status null or not done, no Magento status', () => {
	assert.deepStrictEqual(buildOpenOrdersWhere(), {
		OR: [
			{ custom_ship_status: null },
			{ NOT: { custom_ship_status: { in: DONE_SHIP_STATUSES, mode: 'insensitive' } } },
		],
	});
});

test('isOpenOrder: only our ship status decides; empty counts as open', () => {
	assert.strictEqual(isOpenOrder({ status: 'processing', custom_ship_status: 'Shipping - Drop Shipped' }), false);
	assert.strictEqual(isOpenOrder({ status: 'complete', custom_ship_status: 'Shipping - Ready To Ship' }), true);
	assert.strictEqual(isOpenOrder({ status: 'processing', custom_ship_status: 'Captured Waiting For Parts' }), true);
	assert.strictEqual(isOpenOrder({ status: 'processing', custom_ship_status: '' }), true);
	assert.strictEqual(isOpenOrder({ status: 'complete', custom_ship_status: '' }), true);
	assert.strictEqual(isOpenOrder({ status: 'canceled', custom_ship_status: 'Please select...' }), true);
	assert.strictEqual(isOpenOrder({ status: 'closed', custom_ship_status: null }), true);
	assert.strictEqual(isOpenOrder({ status: null, custom_ship_status: null }), true);
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
	assert.deepStrictEqual(args.select, { entity_id: true, increment_id: true, created_at: true, customer_email: true, shipping_telephone: true, status: true, custom_ship_status: true });
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

// 2026-09-16, second revision: the team tracks progress in custom_ship_status
// (Magento never closes drop-shipped orders: 1,077 "processing" orders were
// already Drop Shipped). Since 2026-09-23 closed = ship status done, Magento
// ignored. When the two sides disagree the API says so and the screen shows a
// warning.
const { DONE_SHIP_STATUSES, isShipStatusDone, isMagentoStatusClosed, isOpenOrder, getStatusDivergence } = require('../../../lib/orders/openOrders.js');

test('DONE_SHIP_STATUSES lists the ship statuses the team uses as finished', () => {
	assert.deepStrictEqual(DONE_SHIP_STATUSES, [
		'Shipping - Drop Shipped',
		'Shipping - Shipped',
		'Pick up - Picked Up',
		'Completely Done',
		'Cancelled',
		'Returned',
	]);
});

test('isShipStatusDone ignores case and spaces, and partial shipments stay open', () => {
	assert.strictEqual(isShipStatusDone('Shipping - Drop Shipped'), true);
	assert.strictEqual(isShipStatusDone('  shipping - shipped '), true);
	assert.strictEqual(isShipStatusDone('Shipping - Partially Shipped'), false);
	assert.strictEqual(isShipStatusDone('Captured Waiting For Parts'), false);
	assert.strictEqual(isShipStatusDone(''), false);
	assert.strictEqual(isShipStatusDone(null), false);
});

test('isMagentoStatusClosed: complete, closed, canceled; null counts as open', () => {
	assert.strictEqual(isMagentoStatusClosed('complete'), true);
	assert.strictEqual(isMagentoStatusClosed('Canceled'), true);
	assert.strictEqual(isMagentoStatusClosed('processing'), false);
	assert.strictEqual(isMagentoStatusClosed(null), false);
});

test('getStatusDivergence: Magento still open but our ship status says done', () => {
	assert.deepStrictEqual(
		getStatusDivergence({ status: 'processing', custom_ship_status: 'Shipping - Drop Shipped' }),
		{ magento_status: 'processing', ship_status: 'Shipping - Drop Shipped' }
	);
});

test('getStatusDivergence: Magento closed but our ship status says still in progress', () => {
	assert.deepStrictEqual(
		getStatusDivergence({ status: 'complete', custom_ship_status: 'Shipping - Ready To Ship' }),
		{ magento_status: 'complete', ship_status: 'Shipping - Ready To Ship' }
	);
});

test('getStatusDivergence is null when both sides agree or our side has no value', () => {
	assert.strictEqual(getStatusDivergence({ status: 'processing', custom_ship_status: 'Captured Waiting For Parts' }), null);
	assert.strictEqual(getStatusDivergence({ status: 'complete', custom_ship_status: 'Shipping - Shipped' }), null);
	assert.strictEqual(getStatusDivergence({ status: 'complete', custom_ship_status: '' }), null);
	assert.strictEqual(getStatusDivergence({ status: 'complete', custom_ship_status: 'Please select...' }), null);
	assert.strictEqual(getStatusDivergence({ status: 'processing', custom_ship_status: null }), null);
});

test('fetchOpenOrders keeps only rows that isOpenOrder accepts, whatever the SQL returned', async () => {
	const rows = [
		{ ...open(4, '200070997', 'j@x.com', '604-555-5375'), status: 'processing', custom_ship_status: '' },
		{ ...open(3, '200067648', 'j@x.com', '604-555-5375'), status: 'processing', custom_ship_status: 'Shipping - Drop Shipped' },
		{ ...open(2, '200060000', 'k@x.com', null), status: 'complete', custom_ship_status: 'Shipping - Ready To Ship' },
		{ ...open(1, '200050000', 'k@x.com', null), status: 'complete', custom_ship_status: '' },
	];
	const prisma = makePrismaStub(rows);
	const result = await fetchOpenOrders(prisma, (w) => w);
	assert.deepStrictEqual(result.map((r) => r.increment_id), ['200070997', '200060000', '200050000']);
	assert.strictEqual(prisma.calls.findMany[0].select.custom_ship_status, true);
	assert.strictEqual(prisma.calls.findMany[0].select.status, true);
});

test('attachOpenOrdersSameCustomer also adds status_divergence per row', () => {
	const orders = [
		{ entity_id: 2, customer_email: 'j@x.com', shipping_telephone: null, status: 'processing', custom_ship_status: 'Shipping - Drop Shipped' },
		{ entity_id: 3, customer_email: 'j@x.com', shipping_telephone: null, status: 'processing', custom_ship_status: '' },
	];
	const result = attachOpenOrdersSameCustomer(orders, []);
	assert.deepStrictEqual(result[0].status_divergence, { magento_status: 'processing', ship_status: 'Shipping - Drop Shipped' });
	assert.strictEqual(result[1].status_divergence, null);
});
