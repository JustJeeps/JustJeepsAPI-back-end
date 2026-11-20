// Classifies one niagarajeeps.ca answer before anything parses it (DD-021).
// The store sits behind Cloudflare: a managed challenge comes back as an HTML
// page (seen with HTTP 200 and 403) instead of the JSON we asked for, and a
// rate limit is HTTP 429 with Retry-After. We never try to solve a challenge;
// the caller stops or waits. Pure: no network, no clock unless passed in.

const CHALLENGE_MARKERS = ['Verifying your connection', 'challenge-platform', '_cf_chl_opt'];

function headerValue(headers, name) {
	if (!headers) return '';
	if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
	return String(headers[name] ?? headers[name.toLowerCase()] ?? '');
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
	const text = String(value ?? '').trim();
	if (!text) return null;
	if (/^\d+$/.test(text)) return Number(text) * 1000;
	const at = Date.parse(text);
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - nowMs);
}

function looksLikeJson(bodyText) {
	const start = String(bodyText ?? '').trimStart()[0];
	return start === '{' || start === '[';
}

function classifyResponse({ status, headers, bodyText = '', expectJson = true, nowMs = Date.now() }) {
	if (status === 429) {
		return { kind: 'rate-limited', status, retryAfterMs: parseRetryAfterMs(headerValue(headers, 'retry-after'), nowMs), reason: 'HTTP 429' };
	}
	if (headerValue(headers, 'cf-mitigated').toLowerCase() === 'challenge') {
		return { kind: 'challenge', status, retryAfterMs: null, reason: 'cf-mitigated: challenge' };
	}
	const text = String(bodyText ?? '');
	const marker = CHALLENGE_MARKERS.find((m) => text.includes(m));
	if (marker) return { kind: 'challenge', status, retryAfterMs: null, reason: `challenge marker "${marker}"` };
	if (status >= 400) return { kind: 'error', status, retryAfterMs: null, reason: `HTTP ${status}` };

	const contentType = headerValue(headers, 'content-type').toLowerCase();
	const isJson = contentType.includes('json') || looksLikeJson(text);
	if (expectJson && !isJson) {
		return { kind: 'challenge', status, retryAfterMs: null, reason: `html (${contentType || 'no content-type'}) on a JSON endpoint` };
	}
	return { kind: isJson ? 'json' : 'html', status, retryAfterMs: null, reason: 'ok' };
}

module.exports = { classifyResponse, parseRetryAfterMs, headerValue, CHALLENGE_MARKERS };
