// Creates Product Replacement pairs (Omix SKU -> Crown SKU) from the Omix-ADA
// "Replace OE" numbers (docs/PRODUCT-REPLACEMENTS.md, "Automatic rows from the
// Omix OE file"). The lookup is symmetric, so one row per pair is enough.
//
// Data access lives here; the decisions live in lib/productReplacements/
// omixOeImport.js; every write goes through the regular replacements service,
// so the business rules (SKU exists, no duplicate, marker) stay in one place.
// Everything is injectable so the tests run against an in-memory prisma stub.

const { planOmixOeImport, buildCrownVariants } = require('../../lib/productReplacements/omixOeImport');
const { COMMENT_MAX_LENGTH } = require('../../config/productReplacements');
const { ProductReplacementError } = require('./errors');

// Postgres handles far more, but 1,000 keeps each `IN (...)` query small.
const CATALOG_CHUNK_SIZE = 1000;
const PROGRESS_EVERY = 200;

const chunkArray = (items, size) => {
	const chunks = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
};

// The author of the automatic rows. created_by_id is required by the schema.
// User.username is not unique, so an ambiguous name is refused rather than
// attributing 1,500 rows to whichever account Postgres returns first.
async function findImportUser(prisma, username) {
	const wanted = String(username ?? '').trim();
	if (!wanted) throw new Error('username is required');
	const matches = await prisma.user.findMany({
		where: { username: { equals: wanted, mode: 'insensitive' } },
		select: { id: true, username: true, email: true, firstname: true, lastname: true },
	});
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const ids = matches.map((user) => user.id).sort((a, b) => a - b).join(', ');
		throw new Error(`User "${wanted}" matches ${matches.length} accounts (ids ${ids}); pass the exact username`);
	}
	return matches[0];
}

function createOmixOeImportService({ prisma, replacementsService, log = console }) {
	const loadOmixProducts = () => prisma.product.findMany({
		where: {
			replace_oe: { not: null },
			vendors: { contains: 'omix-ada', mode: 'insensitive' },
		},
		select: { sku: true, replace_oe: true },
	});

	const catalogSkusOf = async (skus) => {
		const found = new Set();
		for (const part of chunkArray([...new Set(skus)], CATALOG_CHUNK_SIZE)) {
			const products = await prisma.product.findMany({ where: { sku: { in: part } }, select: { sku: true } });
			for (const product of products) found.add(product.sku);
		}
		return found;
	};

	// Active and removed rows touching the Omix SKUs on either side: a pair
	// removed by hand must not come back, whichever way it was registered.
	const existingRowsOf = async (omixSkus) => {
		const rows = [];
		for (const part of chunkArray(omixSkus, CATALOG_CHUNK_SIZE)) {
			rows.push(...await prisma.productReplacement.findMany({
				where: { OR: [{ source_sku: { in: part } }, { replacement_sku: { in: part } }] },
				select: { source_sku: true, replacement_sku: true, kind: true, deletedAt: true },
			}));
		}
		return rows;
	};

	async function run({ user, confirm = false }) {
		const products = await loadOmixProducts();
		const candidates = products.flatMap((product) => buildCrownVariants(product.replace_oe));
		const catalogSkus = await catalogSkusOf(candidates);
		const existingRows = await existingRowsOf(products.map((product) => product.sku));
		const plan = planOmixOeImport({ products, catalogSkus, existingRows, commentMaxLength: COMMENT_MAX_LENGTH });

		let created = 0;
		const failed = [];
		if (confirm) {
			for (const [index, entry] of plan.creates.entries()) {
				try {
					const rows = await replacementsService.createReplacements({
						user,
						source_sku: entry.source_sku,
						replacements: entry.replacements,
					});
					created += rows.length;
				} catch (error) {
					// A rule violation (a pair registered meanwhile, a marker added
					// meanwhile) is reported for that source; anything else is a real
					// failure and stops the run. Each source is its own transaction, so
					// what was created before stays and a re-run skips it; the error
					// carries the partial report so the operator knows where it stopped.
					if (!(error instanceof ProductReplacementError)) {
						error.partialReport = { created, failed, processed: index, total: plan.creates.length };
						throw error;
					}
					failed.push({ source_sku: entry.source_sku, pairs: entry.replacements.length, code: error.code, message: error.message });
				}
				if ((index + 1) % PROGRESS_EVERY === 0) {
					log.log(`   ${index + 1}/${plan.creates.length} sources processed, ${created} pairs created`);
				}
			}
		}

		const pairsNotCreated = failed.reduce((sum, entry) => sum + entry.pairs, 0);
		return { confirm, totals: plan.totals, skipped: plan.skipped, creates: plan.creates, created, failed, pairsNotCreated };
	}

	return { run };
}

module.exports = { createOmixOeImportService, findImportUser, CATALOG_CHUNK_SIZE };
