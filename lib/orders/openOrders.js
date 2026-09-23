// "Open orders of the same customer" for the Orders screen (Pricing Tool).
//
// An order is OPEN while its PO is not set: custom_po_number contains
// "not set" (case-insensitive). It is the same rule as the icon next to the
// order number on the Orders screen (red or yellow = open, green = closed),
// decided 2026-09-23. Neither our ship status nor Magento's status is part of
// the rule (a customer showed "2 open orders" for an order that already had its
// PO and a "Needs QB Invoice" ship status).
//
// The ship status is used only for the warning: when Magento and our ship
// status disagree, getStatusDivergence says so and the Orders screen shows a warning
// next to the order number.
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

const DONE_SHIP_STATUSES = [
	'Shipping - Drop Shipped',
	'Shipping - Shipped',
	'Pick up - Picked Up',
	'Completely Done',
	'Cancelled',
	'Returned',
];

// Values that mean "nobody filled our field yet".
const EMPTY_SHIP_STATUSES = ['', 'Please select...'];

const normalizeShipStatus = (value) => String(value || '').trim().toLowerCase();

const hasShipStatus = (value) => {
	const normalized = normalizeShipStatus(value);
	return normalized !== '' && !EMPTY_SHIP_STATUSES.some((empty) => empty.toLowerCase() === normalized);
};

const isShipStatusDone = (value) => {
	const normalized = normalizeShipStatus(value);
	return normalized !== '' && DONE_SHIP_STATUSES.some((done) => done.toLowerCase() === normalized);
};

const isMagentoStatusClosed = (status) =>
	status != null && CLOSED_ORDER_STATUSES.includes(String(status).trim().toLowerCase());

// The rule, the same test as the green icon in OrderTable.jsx. The SQL below
// only pre-filters; this decides.
const isOpenOrder = (order) =>
	String(order?.custom_po_number || '').trim().toLowerCase().includes('not set');

// Both sides have a value and disagree: Magento still open but we shipped it,
// or Magento closed but we still show it in progress.
const getStatusDivergence = (order) => {
	if (!hasShipStatus(order?.custom_ship_status)) return null;
	const ourSideDone = isShipStatusDone(order.custom_ship_status);
	const magentoClosed = isMagentoStatusClosed(order?.status);
	if (ourSideDone === magentoClosed) return null;
	return { magento_status: order.status, ship_status: order.custom_ship_status };
};

const buildOpenOrdersWhere = () => ({
	custom_po_number: { contains: 'not set', mode: 'insensitive' },
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
	const rows = await prisma.order.findMany({
		where: wrapWhere(buildOpenOrdersWhere()),
		select: {
			entity_id: true,
			increment_id: true,
			created_at: true,
			customer_email: true,
			shipping_telephone: true,
			status: true,
			custom_ship_status: true,
			custom_po_number: true,
		},
		orderBy: { created_at: 'desc' },
	});
	return rows.filter(isOpenOrder);
};

const attachOpenOrdersSameCustomer = (orders, openOrders) =>
	orders.map((order) => ({
		...order,
		open_orders_same_customer: openOrders
			.filter((open) => isSameCustomer(order, open))
			.map(({ entity_id, increment_id, created_at }) => ({ entity_id, increment_id, created_at })),
		status_divergence: getStatusDivergence(order),
	}));

module.exports = {
	CLOSED_ORDER_STATUSES,
	DONE_SHIP_STATUSES,
	buildPoNotSetOr,
	buildOpenOrdersWhere,
	isShipStatusDone,
	isMagentoStatusClosed,
	isOpenOrder,
	getStatusDivergence,
	normalizeEmail,
	normalizePhone,
	isSameCustomer,
	fetchOpenOrders,
	attachOpenOrdersSameCustomer,
};
