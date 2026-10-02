// In-memory prisma stub shared by the Product Replacement tests. It covers
// ONLY the query shapes the services use (same approach as
// test/lib/reviews/reviewServices.test.js). No database.
function makePrismaStub({ products = [], extraUsers = [] } = {}) {
	const replacements = [];
	const comments = [];
	const users = new Map([
		[1, { id: 1, username: 'paula', email: 'paula@x', firstname: 'Paula', lastname: 'P' }],
		[2, { id: 2, username: 'tess', email: 'tess@x', firstname: 'Tess', lastname: 'T' }],
		[3, { id: 3, username: 'ricardo', email: 'ricardo@x', firstname: 'Ricardo', lastname: 'R' }],
		[4, { id: 4, username: 'admin', email: 'admin@x', firstname: 'Admin', lastname: '' }],
	]);
	for (const user of extraUsers) users.set(user.id, user);
	let nextId = 1;

	const pick = (row, select) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
	const userFor = (id, select) => (select ? pick(users.get(id), select) : users.get(id));

	const matchesStringFilter = (value, filter) => {
		if (filter === undefined) return true;
		if (typeof filter === 'string') return value === filter;
		if (filter.in) return filter.in.includes(value);
		if (filter.not === null) return value !== null && value !== undefined;
		if (filter.equals !== undefined) {
			return filter.mode === 'insensitive'
				? String(value || '').toLowerCase() === String(filter.equals).toLowerCase()
				: value === filter.equals;
		}
		if (filter.contains !== undefined) {
			const haystack = filter.mode === 'insensitive' ? String(value || '').toLowerCase() : String(value || '');
			const needle = filter.mode === 'insensitive' ? filter.contains.toLowerCase() : filter.contains;
			return haystack.includes(needle);
		}
		return true;
	};

	const matchesReplacement = (row, where = {}) => {
		if (where.id !== undefined && row.id !== where.id) return false;
		if (where.deletedAt === null && row.deletedAt !== null) return false;
		if (!matchesStringFilter(row.source_sku, where.source_sku)) return false;
		if (!matchesStringFilter(row.replacement_sku, where.replacement_sku)) return false;
		if (where.kind !== undefined && !matchesStringFilter(row.kind || 'replacement', where.kind)) return false;
		if (where.OR && !where.OR.some((clause) => matchesReplacement(row, clause))) return false;
		return true;
	};

	const commentsOf = (replacementId, args = {}) => {
		let found = comments.filter((comment) => comment.replacement_id === replacementId);
		if (args.where?.deletedAt === null) found = found.filter((comment) => comment.deletedAt === null);
		found = found.sort((a, b) => a.id - b.id);
		return found.map((comment) => hydrateComment(comment, args.include));
	};

	const hydrateComment = (comment, include) => ({
		...comment,
		...(include?.author ? { author: userFor(comment.author_id, include.author.select) } : {}),
	});

	const hydrateReplacement = (row, include) => ({
		...row,
		...(include?.createdBy ? { createdBy: userFor(row.created_by_id, include.createdBy.select) } : {}),
		...(include?.comments ? { comments: commentsOf(row.id, include.comments === true ? {} : include.comments) } : {}),
	});

	const stub = {
		replacements,
		comments,
		productFindManyCalls: [],
		product: {
			findMany: async ({ where = {}, select, take } = {}) => {
				stub.productFindManyCalls.push({ where, select, take });
				let found = products.filter((product) =>
					Object.entries(where).every(([field, filter]) => matchesStringFilter(product[field], filter)));
				if (take) found = found.slice(0, take);
				return select ? found.map((product) => pick(product, select)) : found.map((product) => ({ ...product }));
			},
		},
		user: {
			findFirst: async ({ where = {}, select } = {}) => {
				const user = [...users.values()].find((entry) => matchesStringFilter(entry.username, where.username));
				return user ? (select ? pick(user, select) : { ...user }) : null;
			},
			findMany: async ({ where = {}, select } = {}) => {
				const found = [...users.values()].filter((entry) => matchesStringFilter(entry.username, where.username));
				return found.map((user) => (select ? pick(user, select) : { ...user }));
			},
		},
		replacementFindManyCalls: [],
		productReplacement: {
			findMany: async ({ where, include, orderBy, take } = {}) => {
				stub.replacementFindManyCalls.push({ where, include, orderBy, take });
				let found = replacements.filter((row) => matchesReplacement(row, where));
				if (orderBy?.createdAt === 'desc') found = [...found].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
				if (take) found = found.slice(0, take);
				return found.map((row) => hydrateReplacement(row, include));
			},
			findFirst: async ({ where, include } = {}) => {
				const row = replacements.find((entry) => matchesReplacement(entry, where));
				return row ? hydrateReplacement(row, include) : null;
			},
			create: async ({ data, include }) => {
				const kind = data.kind || 'replacement';
				const duplicate = replacements.some((row) =>
					row.deletedAt === null && row.source_sku === data.source_sku
					&& ((kind === 'none' && (row.kind || 'replacement') === 'none')
						|| (kind === 'replacement' && row.replacement_sku !== null && row.replacement_sku === data.replacement_sku)));
				if (duplicate) {
					const error = new Error('Unique constraint failed');
					error.code = 'P2002';
					throw error;
				}
				const row = {
					id: nextId++,
					source_sku: data.source_sku,
					replacement_sku: data.replacement_sku === undefined ? null : data.replacement_sku,
					kind,
					created_by_id: data.created_by_id,
					createdAt: new Date(),
					deletedAt: null,
					deletedById: null,
				};
				replacements.push(row);
				for (const entry of data.comments?.create || []) {
					comments.push({ id: nextId++, replacement_id: row.id, deletedAt: null, deletedById: null, createdAt: new Date(), ...entry });
				}
				return hydrateReplacement(row, include);
			},
			update: async ({ where, data }) => {
				const row = replacements.find((entry) => entry.id === where.id);
				Object.assign(row, data);
				return { ...row };
			},
			count: async ({ where } = {}) => replacements.filter((row) => matchesReplacement(row, where)).length,
			groupBy: async ({ where, _max, orderBy, skip = 0, take } = {}) => {
				const groups = new Map();
				for (const row of replacements) {
					if (!matchesReplacement(row, where)) continue;
					const group = groups.get(row.source_sku) || { source_sku: row.source_sku, count: 0, maxCreatedAt: null, maxId: 0 };
					group.count += 1;
					group.maxCreatedAt = group.maxCreatedAt && group.maxCreatedAt > row.createdAt ? group.maxCreatedAt : row.createdAt;
					group.maxId = Math.max(group.maxId, row.id);
					groups.set(row.source_sku, group);
				}
				let list = [...groups.values()];
				const orders = Array.isArray(orderBy) ? orderBy : (orderBy ? [orderBy] : []);
				if (orders.some((order) => order._max?.createdAt === 'desc')) {
					list.sort((a, b) => (b.maxCreatedAt - a.maxCreatedAt) || (b.maxId - a.maxId));
				}
				list = list.slice(skip, take === undefined ? undefined : skip + take);
				return list.map((group) => ({
					source_sku: group.source_sku,
					_count: { _all: group.count },
					...(_max ? { _max: { ...(_max.createdAt ? { createdAt: group.maxCreatedAt } : {}), ...(_max.id ? { id: group.maxId } : {}) } } : {}),
				}));
			},
		},
		productReplacementComment: {
			create: async ({ data, include }) => {
				const comment = { id: nextId++, deletedAt: null, deletedById: null, createdAt: new Date(), ...data };
				comments.push(comment);
				return hydrateComment(comment, include);
			},
			findFirst: async ({ where } = {}) => {
				const comment = comments.find((entry) =>
					entry.id === where.id && (where.replacement_id === undefined || entry.replacement_id === where.replacement_id)
					&& (where.deletedAt !== null || entry.deletedAt === null));
				return comment ? { ...comment } : null;
			},
			update: async ({ where, data }) => {
				const comment = comments.find((entry) => entry.id === where.id);
				Object.assign(comment, data);
				return { ...comment };
			},
		},
		$transaction: async (fn) => {
			// Real Prisma rolls the whole callback back on a throw; mirror that.
			const snapshot = { replacements: replacements.length, comments: comments.length };
			try {
				return await fn(stub);
			} catch (error) {
				replacements.length = snapshot.replacements;
				comments.length = snapshot.comments;
				throw error;
			}
		},
	};
	return stub;
}

const PRODUCTS = [
	{ sku: 'CRO-83503077', name: 'Crown Front Lower Control Arm JK', image: 'img-cro', url_path: 'https://www.justjeeps.com/cro.html', price: 199.95, status: 1, vendorProducts: [], competitorProducts: [] },
	{ sku: 'MOO-RK620185', name: 'Moog Front Lower Control Arm JK', image: 'img-moo', url_path: 'https://www.justjeeps.com/moo.html', price: 189.95, status: 1, vendorProducts: [{ vendor_cost: 118.4, vendor: { name: 'Meyer' } }], competitorProducts: [] },
	{ sku: 'OMX-18282.05', name: 'Omix-ADA Front Lower Control Arm JK', image: 'img-omx', url_path: null, price: 150, status: 1, vendorProducts: [], competitorProducts: [] },
	{ sku: 'RUG-11540.11', name: 'Rugged Ridge Floor Liner Kit JL', image: 'img-rug', url_path: null, price: 187.5, status: 1, vendorProducts: [], competitorProducts: [] },
];


module.exports = { makePrismaStub, PRODUCTS };
