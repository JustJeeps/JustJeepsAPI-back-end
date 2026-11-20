/* eslint-disable no-console */
// Read-only brand discovery for MyTruckPoint (DD-022). Reads the collections
// index and the first products page of every collection whose name matches a
// brand we sell, measures the SKU code, and writes:
//   discovery.json          every candidate with its measure and decision
//   proposal.txt            the vendors_prefix.js fields of the auto brands
//   team-review.csv         the brands a person must confirm (Same brand? yes/no)
// Nothing is written to the database or to vendors_prefix.js.
//
//   SCRAPER_CONTACT_EMAIL=... node scripts/mytruckpoint-brand-discovery.js [--delay-ms 3000]
//
// Every response is cached under the output dir, so a rerun resumes and makes
// no request it already made.

const fs = require('fs');
const path = require('path');

const vendorsPrefix = require('../prisma/seeds/hard-code_data/vendors_prefix');
const { MYTRUCKPOINT_PROFILE } = require('../lib/competitors/mytruckpoint/profile');
const { DEFAULTS } = require('../config/mytruckpoint');
const { createShopifyClient } = require('../lib/competitors/shopify/shopifyClient');
const { createRequester } = require('../lib/competitors/shopify/requester');
const { createCookieJar } = require('../lib/competitors/shopify/cookieJar');
const { toCsv } = require('../lib/competitors/shopify/csv');
const { nameCandidates, decideAll, measureSample, proposalLines } = require('../lib/competitors/mytruckpoint/discovery');

const PAGE_SIZE = 250;
const OUT_DIR = path.join(__dirname, '..', 'prisma', 'seeds', 'logs', 'mytruckpoint', 'discovery');
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const logger = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function delayArg(argv) {
	const i = argv.indexOf('--delay-ms');
	const value = i >= 0 ? Number(argv[i + 1]) : DEFAULTS.requestDelayMs;
	if (!Number.isFinite(value) || value < 1000) throw new Error('--delay-ms must be 1000 or more');
	return value;
}

async function cached(name, fetchFn) {
	const file = path.join(CACHE_DIR, `${name}.json`);
	if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
	const value = await fetchFn();
	fs.writeFileSync(file, JSON.stringify(value));
	return value;
}

async function readIndex(run, client) {
	const collections = [];
	for (let page = 1; page <= MYTRUCKPOINT_PROFILE.maxIndexPages; page += 1) {
		const body = await cached(`index-${page}`, () => run(`index page ${page}`, () => client.fetchCollectionsIndex(page, PAGE_SIZE)));
		collections.push(...body.collections.map((c) => ({ handle: c.handle, title: c.title, products_count: c.products_count })));
		if (body.collections.length < PAGE_SIZE) return collections;
	}
	throw new Error(`collections index has more than ${MYTRUCKPOINT_PROFILE.maxIndexPages} pages`);
}

function reviewRows(decisions) {
	return decisions.filter((d) => d.status === 'review' || d.status === 'flagged').map((d) => ({
		'MyTruckPoint brand': d.title, Link: `${DEFAULTS.baseUrl}/collections/${d.handle}`, 'Products there': d.productsCount,
		'Our brand': `${d.brandName} (${d.jjPrefix})`, 'Same brand? (yes/no)': '', Why: d.reason,
	}));
}

function writeOutputs(collections, decisions) {
	const mapped = new Set(decisions.filter((d) => d.status !== 'rejected').map((d) => d.jjPrefix));
	const notFound = [...new Map(vendorsPrefix.filter((r) => r.jj_prefix && r.brand_name && !mapped.has(r.jj_prefix)).map((r) => [r.jj_prefix, r.brand_name]))];
	fs.writeFileSync(path.join(OUT_DIR, 'discovery.json'), JSON.stringify({ collections: collections.length, decisions, notFound }, null, 1));
	fs.writeFileSync(path.join(OUT_DIR, 'proposal.txt'), `${proposalLines(decisions).join('\n')}\n`);
	const rows = reviewRows(decisions);
	fs.writeFileSync(path.join(OUT_DIR, 'team-review.csv'), toCsv(Object.keys(rows[0] || { 'MyTruckPoint brand': '' }), rows));
	const count = (s) => decisions.filter((d) => d.status === s).length;
	logger.info(`[mytruckpoint] discovery: ${collections.length} collections, ${decisions.length} candidates: auto=${count('auto')} review=${count('review')} flagged=${count('flagged')} rejected=${count('rejected')}; ${notFound.length} of our brands without a collection`);
	logger.info(`[mytruckpoint] outputs in ${OUT_DIR}`);
}

async function main() {
	const contactEmail = String(process.env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the User-Agent');
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const profile = MYTRUCKPOINT_PROFILE;
	const client = createShopifyClient({ fetch, baseUrl: DEFAULTS.baseUrl, userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`, jar: createCookieJar(), profile });
	const requester = createRequester({ sleep, delayMs: delayArg(process.argv), jitterMs: DEFAULTS.jitterMs, logger, profile });
	const collections = await readIndex(requester.run, client);
	const candidates = nameCandidates(collections, vendorsPrefix);
	const measures = {};
	for (const handle of [...new Set(candidates.map((c) => c.handle))]) {
		const page = await cached(`page1-${handle}`, () => requester.run(`sample ${handle}`, () => client.fetchCollectionPage({ handle, page: 1, limit: PAGE_SIZE })));
		measures[handle] = measureSample(page.products);
	}
	writeOutputs(collections, decideAll(candidates, measures));
	logger.info(`[mytruckpoint] requests made this run: ${requester.stats().requests}`);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[mytruckpoint] discovery FAILED: ${error.message}`);
		process.exitCode = 1;
	});
}
