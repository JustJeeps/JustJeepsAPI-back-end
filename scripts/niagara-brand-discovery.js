/* eslint-disable no-console */
// Read-only brand discovery for Niagara Jeeps (DD-021 step 2). Reads the
// shop-by-brand page (the brand list Ricardo pointed at), the collections index
// and the first products page of every brand we also sell, then writes a
// review report: Niagara label, collection handle, our jj_prefix, the SKU
// prefix Niagara uses and samples. Nothing is written to the database or to
// vendors_prefix.js; the approved rows are copied there by hand.
//
//   SCRAPER_CONTACT_EMAIL=... node scripts/niagara-brand-discovery.js
//   ... --all            also sample brands we do not carry
//   ... --delay-ms 3000  spacing between requests
//
// Each brand page is cached under the output dir, so an interrupted run
// resumes where it stopped.

const fs = require('fs');
const path = require('path');

const vendorsPrefix = require('../prisma/seeds/hard-code_data/vendors_prefix');
const { parseBrandPage } = require('../lib/competitors/niagara/brandPage');
const { suggestBrandMatch, inferSkuPrefix, dominantVendor } = require('../lib/competitors/niagara/brandMap');
const { createShopifyClient } = require('../lib/competitors/niagara/shopifyClient');
const { createRequester } = require('../lib/competitors/niagara/requester');
const { createCookieJar } = require('../lib/competitors/niagara/cookieJar');
const { toCsv } = require('../lib/competitors/niagara/csv');

const BASE_URL = 'https://niagarajeeps.ca';
const PAGE_SIZE = 250;
const MAX_INDEX_PAGES = 20;
const DEFAULT_DELAY_MS = 3000;
const JITTER_MS = 1000;
const OUT_DIR = path.join(__dirname, '..', 'prisma', 'seeds', 'logs', 'niagara');
const CACHE_DIR = path.join(OUT_DIR, 'discovery-cache');
const CSV_COLUMNS = [
	'tier', 'niagara_label', 'niagara_labels', 'handle', 'products_count', 'page1_products', 'page1_variants',
	'dominant_vendor', 'vendor_share', 'sku_prefix', 'prefix_share', 'sample_skus', 'jj_prefix', 'our_brand_name',
];

const logger = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 1000) / 1000;

function parseArgs(argv) {
	const args = { all: false, delayMs: DEFAULT_DELAY_MS };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--all') args.all = true;
		else if (argv[i] === '--delay-ms') args.delayMs = Math.max(1000, Number(argv[++i]) || DEFAULT_DELAY_MS);
	}
	return args;
}

function slimPage(products) {
	return products.map((p) => ({
		vendor: p.vendor,
		skus: (p.variants || []).map((v) => v.sku).filter(Boolean),
	}));
}

async function loadIndex(client, requester) {
	const counts = new Map();
	for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
		const { collections } = await requester.run(`index page ${page}`, () => client.fetchCollectionsIndex(page, PAGE_SIZE));
		for (const c of collections) counts.set(c.handle, Number(c.products_count) || 0);
		if (collections.length < PAGE_SIZE) break;
	}
	return counts;
}

async function firstPage(handle, client, requester) {
	const cacheFile = path.join(CACHE_DIR, `${handle}.json`);
	if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
	const { products } = await requester.run(`brand ${handle}`, () => client.fetchCollectionPage({ handle, page: 1, limit: PAGE_SIZE }));
	const slim = slimPage(products);
	fs.writeFileSync(cacheFile, JSON.stringify(slim));
	return slim;
}

function brandRows(brand, suggestion, count, page) {
	const skus = page ? page.flatMap((p) => p.skus) : [];
	const prefix = inferSkuPrefix(skus);
	const vendor = dominantVendor(page ? page.map((p) => p.vendor) : []);
	const base = {
		tier: suggestion.tier, niagara_label: brand.label, niagara_labels: brand.labels.join(' | '), handle: brand.handle,
		products_count: count ?? '', page1_products: page ? page.length : '', page1_variants: page ? skus.length : '',
		dominant_vendor: vendor.vendor, vendor_share: page ? round(vendor.share) : '',
		sku_prefix: page ? prefix.prefix : '', prefix_share: page ? round(prefix.share) : '', sample_skus: prefix.samples.join(' '),
	};
	if (!suggestion.candidates.length) return [{ ...base, jj_prefix: '', our_brand_name: '' }];
	return suggestion.candidates.map((c) => ({ ...base, jj_prefix: c.jj_prefix, our_brand_name: c.brand_name }));
}

async function main() {
	const contactEmail = String(process.env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the User-Agent');
	const args = parseArgs(process.argv.slice(2));
	fs.mkdirSync(CACHE_DIR, { recursive: true });

	const client = createShopifyClient({ fetch, baseUrl: BASE_URL, userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`, jar: createCookieJar() });
	const requester = createRequester({ sleep, delayMs: args.delayMs, jitterMs: JITTER_MS, logger });

	const brands = parseBrandPage(await requester.run('brand page', () => client.fetchBrandPage()));
	if (!brands.length) throw new Error('the shop-by-brand page listed no brands: layout changed?');
	const index = await loadIndex(client, requester);
	logger.info(`[niagara-discovery] ${brands.length} brands on the page, ${index.size} collections in the index`);

	const rows = [];
	for (const [i, brand] of brands.entries()) {
		const suggestion = suggestBrandMatch(brand, vendorsPrefix);
		const sample = args.all || suggestion.tier !== 'unmapped';
		let page = null;
		if (sample && index.has(brand.handle)) {
			page = await firstPage(brand.handle, client, requester).catch((err) => {
				logger.warn(`[niagara-discovery] ${brand.handle}: ${err.code || ''} ${err.message}`);
				return null;
			});
		}
		rows.push(...brandRows(brand, suggestion, index.get(brand.handle), page));
		if ((i + 1) % 20 === 0) logger.info(`[niagara-discovery] ${i + 1}/${brands.length} brands`);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const jsonFile = path.join(OUT_DIR, `brand-discovery-${stamp}.json`);
	const csvFile = path.join(OUT_DIR, `brand-discovery-${stamp}.csv`);
	fs.writeFileSync(jsonFile, JSON.stringify({ generatedAt: new Date().toISOString(), brands: brands.length, stats: requester.stats(), rows }, null, 2));
	fs.writeFileSync(csvFile, toCsv(CSV_COLUMNS, rows));

	const tiers = rows.reduce((acc, r) => ({ ...acc, [r.tier]: (acc[r.tier] || 0) + 1 }), {});
	logger.info(`[niagara-discovery] rows by tier: ${JSON.stringify(tiers)} requests: ${JSON.stringify(requester.stats())}`);
	logger.info(`[niagara-discovery] report: ${csvFile}`);
}

main().catch((err) => {
	console.error(`[niagara-discovery] failed: ${err.message}`);
	process.exitCode = 1;
});
