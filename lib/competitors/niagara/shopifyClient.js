// The three public Shopify reads we make on niagarajeeps.ca (DD-021): a brand
// collection page of products.json, the collections index and the
// shop-by-brand HTML page. One request per call, no retry and no pacing here
// (see requester.js). Every failure is an Error with a code, the HTTP status
// and whether a retry makes sense. A challenge page is never parsed.

const { classifyResponse } = require('./challenge');

const PAGE_CAP_MESSAGE = /exceeds the 25000 limit/i;

function makeError(code, message, extra = {}) {
	const error = new Error(`${code}: ${message}`);
	error.code = code;
	Object.assign(error, { retryable: false, status: null, retryAfterMs: null }, extra);
	return error;
}

function httpError(url, verdict, bodyText) {
	const { status } = verdict;
	if (status === 400 && PAGE_CAP_MESSAGE.test(bodyText)) return makeError('NIAGARA_PAGE_CAP', `${url} hit the 25,000 products.json cap`, { status });
	if (status === 404) return makeError('NIAGARA_NOT_FOUND', `${url} answered HTTP 404`, { status });
	return makeError('NIAGARA_HTTP_ERROR', `${url} answered HTTP ${status}`, { status, retryable: status >= 500 });
}

function createShopifyClient({ fetch, baseUrl, userAgent, timeoutMs = 30000, jar = null }) {
	async function request(pathname, { expectJson }) {
		const url = `${baseUrl}${pathname}`;
		const headers = { 'user-agent': userAgent, accept: expectJson ? 'application/json' : 'text/html' };
		if (jar && jar.header()) headers.cookie = jar.header();
		let bodyText;
		let res;
		try {
			res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
			if (jar) jar.storeFrom(res);
			bodyText = await res.text();
		} catch (err) {
			throw makeError('NIAGARA_FETCH_FAILED', `${url}: ${err.message}`, { retryable: true });
		}
		const verdict = classifyResponse({ status: res.status, headers: res.headers, bodyText, expectJson });
		if (verdict.kind === 'rate-limited') {
			throw makeError('NIAGARA_RATE_LIMITED', `${url} answered HTTP 429`, { status: 429, retryable: true, retryAfterMs: verdict.retryAfterMs });
		}
		if (verdict.kind === 'challenge') throw makeError('NIAGARA_CHALLENGED', `${url}: ${verdict.reason}`, { status: res.status });
		if (verdict.kind === 'error') throw httpError(url, verdict, bodyText);
		if (!expectJson) return bodyText;
		try {
			return JSON.parse(bodyText);
		} catch (err) {
			throw makeError('NIAGARA_BAD_BODY', `${url}: body is not JSON (${err.message})`, { status: res.status });
		}
	}

	function arrayField(body, field, pathname) {
		if (!body || !Array.isArray(body[field])) throw makeError('NIAGARA_BAD_BODY', `${baseUrl}${pathname}: no "${field}" array in the body`);
		return body[field];
	}

	async function fetchCollectionPage({ handle, page, limit }) {
		const pathname = `/collections/${encodeURIComponent(handle)}/products.json?limit=${limit}&page=${page}`;
		return { products: arrayField(await request(pathname, { expectJson: true }), 'products', pathname) };
	}

	async function fetchCollectionsIndex(page, limit = 250) {
		const pathname = `/collections.json?limit=${limit}&page=${page}`;
		return { collections: arrayField(await request(pathname, { expectJson: true }), 'collections', pathname) };
	}

	const fetchBrandPage = () => request('/pages/shop-by-brand', { expectJson: false });

	return { fetchCollectionPage, fetchCollectionsIndex, fetchBrandPage };
}

module.exports = { createShopifyClient, makeError };
