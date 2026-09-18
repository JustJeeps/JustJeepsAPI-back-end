// The Lowriders brand page inlines the PartsLogic widget config. We read the
// key and groupId from it on every run so a rotation heals itself. The key is
// never logged. Pure: fetch and logger are injected.

const KEY_RE = /PartslogicUi\.config\(\s*\{[^}]*API_KEY:\s*"([0-9a-fA-F-]{36})"/;
const GROUP_RE = /ProductListWrapper\s*,\s*\{[^}]*groupId:\s*(\d+)/;

function parseWidgetConfig(html) {
	const text = typeof html === 'string' ? html : '';
	const key = text.match(KEY_RE);
	const group = text.match(GROUP_RE);
	return { apiKey: key ? key[1] : null, groupId: group ? Number(group[1]) : null };
}

async function discoverConfig({ fetch, brandPageUrl, fallbackApiKey, userAgent, timeoutMs, logger }) {
	let parsed = { apiKey: null, groupId: null };
	try {
		const res = await fetch(brandPageUrl, {
			headers: { 'user-agent': userAgent, accept: 'text/html' },
			signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
		});
		if (res.ok) {
			parsed = parseWidgetConfig(await res.text());
		} else {
			logger.warn(`[lowriders] brand page answered HTTP ${res.status}`);
		}
	} catch (err) {
		logger.warn(`[lowriders] brand page fetch failed: ${err.message}`);
	}

	if (parsed.apiKey) return { apiKey: parsed.apiKey, groupId: parsed.groupId, source: 'page' };
	if (fallbackApiKey) {
		logger.warn('[lowriders] no API key on the brand page, using LOWRIDERS_PARTSLOGIC_API_KEY');
		return { apiKey: fallbackApiKey, groupId: parsed.groupId, source: 'env' };
	}
	const error = new Error('LOWRIDERS_CONFIG_NOT_FOUND: no API key on the brand page and no LOWRIDERS_PARTSLOGIC_API_KEY fallback');
	error.code = 'LOWRIDERS_CONFIG_NOT_FOUND';
	throw error;
}

module.exports = { parseWidgetConfig, discoverConfig };
