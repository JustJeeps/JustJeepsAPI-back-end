/* eslint-disable no-console */
// Read-only probe for niagarajeeps.ca (DD-021 phase 0). Answers one question:
// does Node's fetch, from this machine, get JSON from the Shopify endpoints or
// the Cloudflare challenge page? Six requests, paced, with our identifying
// User-Agent. It never opens the database and never logs in or posts anything.
//
//   SCRAPER_CONTACT_EMAIL=... node scripts/niagara-probe.js
//   node scripts/niagara-probe.js --delay-ms 5000 --no-cookies
//
// Exit: 0 every JSON endpoint answered JSON, 3 challenged, 4 rate-limited,
// 1 other failure.

const { classifyResponse } = require('../lib/competitors/niagara/challenge');
const { createCookieJar } = require('../lib/competitors/niagara/cookieJar');

const BASE_URL = 'https://niagarajeeps.ca';
const DEFAULT_DELAY_MS = 3000;
const TIMEOUT_MS = 30000;
const PROBE_BRAND = 'bilstein';
const EXIT = { ok: 0, failed: 1, challenged: 3, rateLimited: 4 };

function parseArgs(argv) {
	const args = { delayMs: DEFAULT_DELAY_MS, cookies: true };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--delay-ms') args.delayMs = Math.max(0, Number(argv[++i]) || DEFAULT_DELAY_MS);
		else if (argv[i] === '--no-cookies') args.cookies = false;
	}
	return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(url, { expectJson, userAgent, jar }) {
	const started = Date.now();
	const headers = { 'user-agent': userAgent, accept: expectJson ? 'application/json' : 'text/html' };
	if (jar && jar.header()) headers.cookie = jar.header();
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (jar) jar.storeFrom(res);
		const bodyText = await res.text();
		const verdict = classifyResponse({ status: res.status, headers: res.headers, bodyText, expectJson });
		let count = '-';
		if (verdict.kind === 'json') {
			const body = JSON.parse(bodyText);
			count = Array.isArray(body.products) ? `${body.products.length} products` : Array.isArray(body.collections) ? `${body.collections.length} collections` : body.product ? '1 product' : 'json';
		}
		console.log([
			`${verdict.kind.padEnd(12)} ${res.status} ${url}`,
			`  content-type=${res.headers.get('content-type') || '-'} server=${res.headers.get('server') || '-'} cf-ray=${res.headers.get('cf-ray') || '-'} cf-mitigated=${res.headers.get('cf-mitigated') || '-'} retry-after=${res.headers.get('retry-after') || '-'}`,
			`  elapsed=${Date.now() - started}ms bytes=${bodyText.length} count=${count} reason=${verdict.reason}`,
		].join('\n'));
		return { verdict, bodyText };
	} catch (err) {
		console.log(`failed       -   ${url}\n  ${err.message}`);
		return { verdict: { kind: 'failed' }, bodyText: '' };
	}
}

async function main() {
	const contactEmail = String(process.env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) {
		console.error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the User-Agent');
		return EXIT.failed;
	}
	const args = parseArgs(process.argv.slice(2));
	const userAgent = `JustJeepsPriceMonitor/1.0 (+${contactEmail})`;
	const jar = args.cookies ? createCookieJar() : null;
	console.log(`[niagara-probe] node ${process.version}, delay ${args.delayMs}ms, cookies ${args.cookies ? 'on' : 'off'}`);

	const steps = [
		{ url: `${BASE_URL}/robots.txt`, expectJson: false },
		{ url: `${BASE_URL}/collections.json?limit=250&page=1`, expectJson: true },
		{ url: `${BASE_URL}/collections/${PROBE_BRAND}/products.json?limit=5&page=1`, expectJson: true },
		{ url: `${BASE_URL}/collections/${PROBE_BRAND}/products.json?limit=5&page=2`, expectJson: true },
		{ url: null, expectJson: true },
		{ url: `${BASE_URL}/pages/shop-by-brand`, expectJson: false },
	];
	const kinds = [];
	let firstHandle = null;
	for (const [index, step] of steps.entries()) {
		if (index > 0) await sleep(args.delayMs);
		const url = step.url || (firstHandle ? `${BASE_URL}/products/${firstHandle}.js` : null);
		if (!url) {
			console.log('skipped      no product handle from the collection page');
			continue;
		}
		const { verdict, bodyText } = await probe(url, { expectJson: step.expectJson, userAgent, jar });
		kinds.push({ kind: verdict.kind, expectJson: step.expectJson });
		if (index === 2 && verdict.kind === 'json') firstHandle = (JSON.parse(bodyText).products || [])[0]?.handle || null;
	}

	const jsonSteps = kinds.filter((k) => k.expectJson);
	if (kinds.some((k) => k.kind === 'rate-limited')) return EXIT.rateLimited;
	if (kinds.some((k) => k.kind === 'challenge')) return EXIT.challenged;
	if (jsonSteps.every((k) => k.kind === 'json') && kinds.every((k) => k.kind !== 'failed' && k.kind !== 'error')) return EXIT.ok;
	return EXIT.failed;
}

main()
	.then((code) => {
		console.log(`[niagara-probe] exit ${code}`);
		process.exitCode = code;
	})
	.catch((err) => {
		console.error(`[niagara-probe] fatal: ${err.message}`);
		process.exitCode = EXIT.failed;
	});
