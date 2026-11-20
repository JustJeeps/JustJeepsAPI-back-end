// Minimal cookie jar for one run against niagarajeeps.ca (DD-021). The 2026-11-02
// recon passed Cloudflare 30/30 only with cookies kept between requests, so the
// client resends whatever the site set. One host, one run, in memory only:
// attributes (path, expiry, flags) are ignored on purpose.

function setCookieLines(headers) {
	if (!headers) return [];
	if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
	if (typeof headers.get === 'function') {
		const value = headers.get('set-cookie');
		return value ? [value] : [];
	}
	return [];
}

function createCookieJar() {
	const cookies = new Map();

	function store(lines) {
		for (const line of lines || []) {
			const pair = String(line).split(';')[0];
			const eq = pair.indexOf('=');
			if (eq <= 0) continue;
			cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}

	return {
		store,
		storeFrom: (response) => store(setCookieLines(response && response.headers)),
		header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
	};
}

module.exports = { createCookieJar };
