// "Open orders of the same customer" for the Orders screen (Pricing Tool).
//
// An order is OPEN when its PO is still "not set" (same rule as the poStatus
// filters in /api/orders) AND its Magento status is not terminal. A null or
// unknown status counts as open on purpose: erring on the side of flagging.
//
// The prisma client is a parameter (no singleton import) so the tests run
// against a stub: the local .env points at the production Postgres.

const CLOSED_ORDER_STATUSES = ['complete', 'closed', 'canceled'];

// Prisma OR-clause for "custom_po_number still not set". Returns a fresh
// array on every call because callers spread it into where.AND.
const buildPoNotSetOr = () => [
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

// `status: null` is listed explicitly: SQL `NOT IN` drops null rows.
const buildOpenOrdersWhere = (emails) => ({
	AND: [
		{ customer_email: { in: emails } },
		{ OR: buildPoNotSetOr() },
		{ OR: [{ status: null }, { status: { notIn: [...CLOSED_ORDER_STATUSES] } }] },
	],
});

// Returns { [customer_email]: [{ entity_id, increment_id, created_at }, ...] }
// newest first. `wrapWhere` is buildVisibleOrdersWhere from server.js, so the
// hidden test-customer orders never make it into the count. It is required on
// purpose: a default would let a new caller skip it without noticing.
const fetchOpenOrdersByCustomer = async (prisma, emails, wrapWhere) => {
	if (typeof wrapWhere !== 'function') {
		throw new TypeError('fetchOpenOrdersByCustomer: wrapWhere is required (pass buildVisibleOrdersWhere)');
	}
	if (!Array.isArray(emails) || emails.length === 0) return {};

	const rows = await prisma.order.findMany({
		where: wrapWhere(buildOpenOrdersWhere(emails)),
		select: { entity_id: true, increment_id: true, created_at: true, customer_email: true },
		orderBy: { created_at: 'desc' },
	});

	const byEmail = {};
	for (const { customer_email, ...order } of rows) {
		if (!byEmail[customer_email]) byEmail[customer_email] = [];
		byEmail[customer_email].push(order);
	}
	return byEmail;
};

const attachOpenOrdersSameCustomer = (orders, byEmail) =>
	orders.map((order) => ({
		...order,
		open_orders_same_customer: (order.customer_email && byEmail[order.customer_email]) || [],
	}));

module.exports = {
	CLOSED_ORDER_STATUSES,
	buildPoNotSetOr,
	buildOpenOrdersWhere,
	fetchOpenOrdersByCustomer,
	attachOpenOrdersSameCustomer,
};
