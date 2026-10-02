// The TDOT storefront inlines its Klevu public key; Klevu's store config JSON
// names the cloud-search host. Both are re-read on every run so a change on
// their side heals itself; env values are the fallback. Pure: fetch and
// logger are injected. The key is never logged.

const KEY_RE = /"search"\s*:\s*\{\s*"apiKey"\s*:\s*"(klevu-[0-9]+)"/;

function parseApiKey(html) {
	const match = typeof html === 'string' ? html.match(KEY_RE) : null;
	return match ? match[1] : null;
}

function parseSearchDomain(config) {
	const domain = config && typeof config.klevu_userSearchDomain === 'string' ? config.klevu_userSearchDomain.trim() : '';
	return domain || null;
}

async function discoverConfig({ fetch, storefrontUrl, klevuConfigBaseUrl, fallbackApiKey, fallbackSearchDomain, userAgent, timeoutMs, logger }) {
	const headers = { 'user-agent': userAgent };
	// A fresh signal per request: one shared timer would count the first fetch
	// against the second.
	const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
	let apiKey = null;
	let searchDomain = null;

	try {
		const res = await fetch(storefrontUrl, { headers: { ...headers, accept: 'text/html' }, signal: signal() });
		if (res.ok) apiKey = parseApiKey(await res.text());
		else logger.warn(`[tdot] storefront answered HTTP ${res.status}`);
	} catch (err) {
		logger.warn(`[tdot] storefront fetch failed: ${err.message}`);
	}

	if (apiKey) {
		try {
			const res = await fetch(`${klevuConfigBaseUrl}/${apiKey}.json`, { headers: { ...headers, accept: 'application/json' }, signal: signal() });
			if (res.ok) searchDomain = parseSearchDomain(await res.json());
			else logger.warn(`[tdot] Klevu config answered HTTP ${res.status}`);
		} catch (err) {
			logger.warn(`[tdot] Klevu config fetch failed: ${err.message}`);
		}
	}

	if (apiKey && searchDomain) return { apiKey, searchDomain, source: 'page' };
	if (fallbackApiKey && fallbackSearchDomain) {
		logger.warn('[tdot] using TDOT_KLEVU_API_KEY and TDOT_KLEVU_SEARCH_DOMAIN from the environment');
		return { apiKey: fallbackApiKey, searchDomain: fallbackSearchDomain, source: 'env' };
	}
	const error = new Error('TDOT_CONFIG_NOT_FOUND: no Klevu key or search domain on the storefront and no env fallback');
	error.code = 'TDOT_CONFIG_NOT_FOUND';
	throw error;
}

module.exports = { parseApiKey, parseSearchDomain, discoverConfig };
