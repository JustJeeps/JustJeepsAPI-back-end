// One page of the PartsLogic products API. Same call the site's own widget
// makes. Errors are described with status and URL only; the key never
// appears in a message.

function makeError(code, message, extra = {}) {
	const error = new Error(`${code}: ${message}`);
	error.code = code;
	Object.assign(error, extra);
	return error;
}

function createPartslogicClient({ fetch, apiKey, baseUrl = 'https://api.sunhammer.io', userAgent, timeoutMs = 30000 }) {
	async function fetchPage({ brandId, page, limit }) {
		const url = `${baseUrl}/products?brands=${encodeURIComponent(brandId)}&limit=${limit}&page=${page}`;
		let res;
		try {
			res = await fetch(url, {
				headers: { 'sunhammer-api-key': apiKey, 'user-agent': userAgent, accept: 'application/json' },
				signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
			});
		} catch (err) {
			throw makeError('LOWRIDERS_FETCH_FAILED', `${url}: ${err.message}`, { url });
		}
		if (res.status === 404) throw makeError('LOWRIDERS_KEY_REJECTED', `${url} answered 404 (key not accepted)`, { url, status: 404 });
		if (!res.ok) throw makeError('LOWRIDERS_HTTP_ERROR', `${url} answered HTTP ${res.status}`, { url, status: res.status });

		let body;
		try {
			body = await res.json();
		} catch (err) {
			throw makeError('LOWRIDERS_BAD_BODY', `${url}: body is not JSON (${err.message})`, { url });
		}
		if (!body || !Array.isArray(body.list)) throw makeError('LOWRIDERS_BAD_BODY', `${url}: no "list" array in the body`, { url });
		return { list: body.list, total: Number(body.total) || 0 };
	}

	return { fetchPage };
}

module.exports = { createPartslogicClient };
