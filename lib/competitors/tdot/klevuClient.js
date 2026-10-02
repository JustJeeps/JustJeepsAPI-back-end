// One Klevu cloud-search request, the same call the TDOT storefront makes
// (verified 2026-10-02: GET .../cloud-search/n-search/search, JSON, 100 per
// page cap). Errors carry a code, a status and whether a retry makes sense;
// the key never appears in a message.

const PAGE_SIZE_MAX = 100;

function makeError(code, message, extra = {}) {
	const error = new Error(`${code}: ${message}`);
	error.code = code;
	Object.assign(error, extra);
	return error;
}

function buildSearchUrl({ searchDomain, apiKey, term, noOfResults = PAGE_SIZE_MAX, paginationStartsFrom = 0 }) {
	const params = new URLSearchParams({
		ticket: apiKey,
		term,
		noOfResults: String(Math.min(Math.max(Number(noOfResults) || PAGE_SIZE_MAX, 1), PAGE_SIZE_MAX)),
		paginationStartsFrom: String(Math.max(Number(paginationStartsFrom) || 0, 0)),
		responseType: 'json',
		klevuShowOutOfStockProducts: 'true',
		klevuSort: 'rel',
		enableFilters: 'false',
	});
	return `https://${searchDomain}/cloud-search/n-search/search?${params.toString()}`;
}

const describe = (url) => url.replace(/ticket=[^&]*/, 'ticket=***');

function createKlevuClient({ fetch, apiKey, searchDomain, userAgent, timeoutMs = 30000 }) {
	async function search({ term, noOfResults = PAGE_SIZE_MAX, paginationStartsFrom = 0 }) {
		const url = buildSearchUrl({ searchDomain, apiKey, term, noOfResults, paginationStartsFrom });
		const safeUrl = describe(url);
		let res;
		try {
			res = await fetch(url, {
				headers: { 'user-agent': userAgent, accept: 'application/json' },
				signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
			});
		} catch (err) {
			throw makeError('TDOT_FETCH_FAILED', `${safeUrl}: ${err.message}`, { url: safeUrl, retryable: true });
		}
		if (!res.ok) {
			const retryable = res.status === 429 || res.status >= 500;
			throw makeError('TDOT_HTTP_ERROR', `${safeUrl} answered HTTP ${res.status}`, { url: safeUrl, status: res.status, retryable });
		}
		let body;
		try {
			body = await res.json();
		} catch (err) {
			throw makeError('TDOT_BAD_BODY', `${safeUrl}: body is not JSON (${err.message})`, { url: safeUrl, retryable: false });
		}
		if (!body || !Array.isArray(body.result) || !body.meta) {
			throw makeError('TDOT_BAD_BODY', `${safeUrl}: no "result" array or "meta" in the body`, { url: safeUrl, retryable: false });
		}
		return {
			records: body.result,
			total: Number(body.meta.totalResultsFound) || 0,
			typeOfQuery: body.meta.typeOfQuery || null,
		};
	}

	return { search };
}

module.exports = { createKlevuClient, buildSearchUrl, PAGE_SIZE_MAX };
