// "Open orders of the same customer" for the Orders screen (Pricing Tool).
//
// An order is OPEN when its Magento status is not terminal (complete, closed,
// canceled). A null or unknown status counts as open on purpose: erring on
// the side of flagging. The PO is NOT part of the rule (decided 2026-09-16:
// with "PO not set" only 21 orders in the whole store were open, one per
// customer, and the tag never showed). Statuses seen in production that
// count as open: processing, parts_incoming, pending, holded, payment_review.
//
// Same customer = same email (case-insensitive) OR same phone (digits only),
// because the same person orders with more than one email or with the phone
// typed in a different format (2026-09-16).
//
// The prisma client is a parameter (no singleton import) so the tests run
// against a stub: the local .env points at the production Postgres.

const CLOSED_ORDER_STATUSES = ['complete', 'closed', 'canceled'];

// Prisma OR-clause for "custom_po_number still not set", used by the poStatus
// filters and metrics in server.js. Returns a fresh array on every call
// because callers spread it into where.AND.
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
const buildOpenOrdersWhere = () => ({
	OR: [{ status: null }, { status: { notIn: [...CLOSED_ORDER_STATUSES] } }],
});

const normalizeEmail = (value) => {
	const email = String(value || '').trim().toLowerCase();
	return email || null;
};

// Digits only; "1" + 10 digits is a North American number with the country
// code, so the 1 is dropped. Fewer than 7 digits is not a phone.
const normalizePhone = (value) => {
	let digits = String(value || '').replace(/\D/g, '');
	if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
	return digits.length >= 7 ? digits : null;
};

const isSameCustomer = (a, b) => {
	const emailA = normalizeEmail(a?.customer_email);
	const phoneA = normalizePhone(a?.shipping_telephone);
	return (
		(emailA != null && emailA === normalizeEmail(b?.customer_email)) ||
		(phoneA != null && phoneA === normalizePhone(b?.shipping_telephone))
	);
};

// Every open order, newest first, with the two identity fields. The list is
// small (tens to a couple of thousand rows) so it is read once per page and
// matched in memory, which is what lets the phone formats be normalized.
// `wrapWhere` is buildVisibleOrdersWhere from server.js, so the hidden
// test-customer orders never make it into the count. It is required on
// purpose: a default would let a new caller skip it without noticing.
const fetchOpenOrders = async (prisma, wrapWhere) => {
	if (typeof wrapWhere !== 'function') {
		throw new TypeError('fetchOpenOrders: wrapWhere is required (pass buildVisibleOrdersWhere)');
	}
	return prisma.order.findMany({
		where: wrapWhere(buildOpenOrdersWhere()),
		select: { entity_id: true, increment_id: true, created_at: true, customer_email: true, shipping_telephone: true },
		orderBy: { created_at: 'desc' },
	});
};

const attachOpenOrdersSameCustomer = (orders, openOrders) =>
	orders.map((order) => ({
		...order,
		open_orders_same_customer: openOrders
			.filter((open) => isSameCustomer(order, open))
			.map(({ entity_id, increment_id, created_at }) => ({ entity_id, increment_id, created_at })),
	}));

module.exports = {
	CLOSED_ORDER_STATUSES,
	buildPoNotSetOr,
	buildOpenOrdersWhere,
	normalizeEmail,
	normalizePhone,
	isSameCustomer,
	fetchOpenOrders,
	attachOpenOrdersSameCustomer,
};
