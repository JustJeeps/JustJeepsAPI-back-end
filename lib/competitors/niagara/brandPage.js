// Parses https://niagarajeeps.ca/pages/shop-by-brand (DD-021), the page
// Ricardo named as the list of every brand Niagara Jeeps sells. Each brand is
// an <a class="njh-brand" data-brand-name="..." href="/collections/<handle>">.
// Category and vehicle links on the same page are not in that grid. Pure.

const ANCHOR = /<a\s[^>]*class="[^"]*\bnjh-brand\b[^"]*"[^>]*>/gi;
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };

const decode = (text) => String(text).replace(/&(amp|quot|#39|apos|lt|gt);/g, (m) => ENTITIES[m]);

function attribute(tag, name) {
	const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
	return match ? decode(match[1]).trim() : '';
}

function handleFromHref(href) {
	const match = String(href).match(/\/collections\/([a-z0-9-]+)/i);
	return match ? match[1].toLowerCase() : '';
}

function parseBrandPage(html) {
	const byHandle = new Map();
	for (const tag of String(html || '').match(ANCHOR) || []) {
		const label = attribute(tag, 'data-brand-name') || attribute(tag, 'data-name');
		const handle = handleFromHref(attribute(tag, 'href'));
		if (!label || !handle) continue;
		const existing = byHandle.get(handle);
		if (!existing) byHandle.set(handle, { label, handle, labels: [label] });
		else if (!existing.labels.includes(label)) byHandle.set(handle, { ...existing, labels: [...existing.labels, label] });
	}
	return [...byHandle.values()];
}

module.exports = { parseBrandPage };
