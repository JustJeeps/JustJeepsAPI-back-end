// Live product info (name, image, description, store page) from the Magento
// REST API, used by the Product Replacement screens so the cards show what
// the store shows today instead of the catalog snapshot in Postgres.
//
// Read only. One GET per batch of SKUs (searchCriteria "in" filter), batches
// sent with a small concurrency, answers cached in memory for a few minutes.
// A failure NEVER throws: the caller falls back to the Product table and the
// answer says `degraded: true` so the UI can tell the user. After a failure a
// short cooldown stops every caller from paying the timeout again. The raw
// axios error is never logged (it carries the Bearer token in config.headers;
// see describeHttpError.js and the 2026-09-13 incident).

const axios = require('axios');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;
// Interactive path: a screen waits for this. Not the seed-oriented MAGENTO_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 5000;
const DESCRIPTION_MAX_LENGTH = 600;
const BODY_HEAD_LENGTH = 200;

// Store origin for the API, the media files and the product pages. Same rule
// as resolveMagentoBaseUrl in server.js (default WITH www: product pages and
// pub/media live there).
function resolveStoreBaseUrl(env = {}) {
	const raw = String(env.MAGENTO_BASE_URL || env.M2_BASE_URL || 'https://www.justjeeps.com').trim();
	const restIndex = raw.indexOf('/rest/');
	const origin = restIndex === -1 ? raw : raw.slice(0, restIndex);
	return origin.replace(/\/+$/, '') || 'https://www.justjeeps.com';
}

// Magento returns attributes as [{ attribute_code, value }], never as named fields.
const customAttribute = (item, code) => {
	const list = Array.isArray(item?.custom_attributes) ? item.custom_attributes : [];
	const found = list.find((entry) => entry && entry.attribute_code === code);
	return found ? found.value : undefined;
};

const htmlToText = (html) => String(html ?? '')
	.replace(/<[^>]*>/g, ' ')
	.replace(/&nbsp;/gi, ' ')
	.replace(/&amp;/gi, '&')
	.replace(/&lt;/gi, '<')
	.replace(/&gt;/gi, '>')
	.replace(/&quot;/gi, '"')
	.replace(/&#39;|&apos;/gi, "'")
	.replace(/\s+/g, ' ')
	.trim();

function parseMagentoProduct(item, baseUrl) {
	const sku = String(item?.sku ?? '').trim();
	const entries = Array.isArray(item?.media_gallery_entries) ? item.media_gallery_entries : [];
	const entry = entries.find((candidate) => candidate && candidate.file && !candidate.disabled)
		|| entries.find((candidate) => candidate && candidate.file)
		|| null;
	const rawFile = entry ? entry.file : customAttribute(item, 'image');
	const file = rawFile ? String(rawFile).replace(/^\/+/, '') : '';
	const image = file ? `${baseUrl}/pub/media/catalog/product/${file}` : null;

	const urlKey = String(customAttribute(item, 'url_key') ?? '').trim();
	const url_path = urlKey ? `${baseUrl}/${urlKey}.html` : null;

	const description = htmlToText(customAttribute(item, 'short_description'))
		|| htmlToText(customAttribute(item, 'description'))
		|| '';

	return {
		sku,
		name: String(item?.name ?? '').trim() || null,
		description: description ? description.slice(0, DESCRIPTION_MAX_LENGTH) : null,
		image,
		url_path,
	};
}

const chunk = (items, size) => {
	const out = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
};

// A 200 whose body is not the product list (WAF or maintenance HTML, a
// { message } from a token without the ACL). Treated as a failure, never as
// "Magento does not know these SKUs".
class MagentoUnexpectedResponseError extends Error {
	constructor(response) {
		super('Magento answered without a product list');
		this.name = 'MagentoUnexpectedResponseError';
		this.code = 'MAGENTO_UNEXPECTED_RESPONSE';
		this.status = Number.isFinite(response?.status) ? response.status : null;
		this.contentType = String(response?.headers?.['content-type'] || '').slice(0, 80) || null;
		const body = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
		this.bodyHead = String(body || '').slice(0, BODY_HEAD_LENGTH);
	}
}

const isHttpError = (error) => Boolean(error && (error.isAxiosError || error.code === 'MAGENTO_UNEXPECTED_RESPONSE'));

const safeErrorFields = (error) => ({
	code: error?.code || null,
	status: Number.isFinite(error?.response?.status) ? error.response.status : (Number.isFinite(error?.status) ? error.status : null),
	message: String(error?.message || '').slice(0, 200),
	...(error?.contentType ? { contentType: error.contentType } : {}),
	...(error?.bodyHead ? { bodyHead: error.bodyHead } : {}),
});

function createMagentoProductInfoClient({
	http = axios,
	env = process.env,
	logger = console,
	now = () => Date.now(),
	ttlMs = Number(env.MAGENTO_PRODUCT_INFO_CACHE_TTL_MS) || DEFAULT_TTL_MS,
	batchSize = Number(env.MAGENTO_PRODUCT_INFO_BATCH) || DEFAULT_BATCH_SIZE,
	concurrency = Number(env.MAGENTO_PRODUCT_INFO_CONCURRENCY) || DEFAULT_CONCURRENCY,
	timeoutMs = Number(env.MAGENTO_PRODUCT_INFO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
	cooldownMs = env.MAGENTO_PRODUCT_INFO_COOLDOWN_MS !== undefined ? Number(env.MAGENTO_PRODUCT_INFO_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS,
	maxCacheEntries = Number(env.MAGENTO_PRODUCT_INFO_CACHE_MAX) || DEFAULT_MAX_CACHE_ENTRIES,
} = {}) {
	const baseUrl = resolveStoreBaseUrl(env);
	// sku -> { expiresAt, product|null }. null = Magento does not know the SKU
	// (cached too, so a SKU that left the store is not asked on every screen).
	const cache = new Map();
	// After a failure, no request until this time (0 = closed).
	let cooldownUntil = 0;

	const token = () => env.MAGENTO_KEY;
	const isConfigured = () => Boolean(token());

	const searchUrl = (skus) => {
		const params = new URLSearchParams();
		params.set('searchCriteria[filter_groups][0][filters][0][field]', 'sku');
		params.set('searchCriteria[filter_groups][0][filters][0][value]', skus.join(','));
		params.set('searchCriteria[filter_groups][0][filters][0][condition_type]', 'in');
		params.set('searchCriteria[pageSize]', String(skus.length));
		return `${baseUrl}/rest/default/V1/products?${params.toString()}`;
	};

	const remember = (sku, product) => {
		if (cache.size >= maxCacheEntries) {
			// Drop expired entries first; if still full, the oldest inserted.
			for (const [key, entry] of cache) {
				if (entry.expiresAt <= now()) cache.delete(key);
			}
			while (cache.size >= maxCacheEntries) {
				cache.delete(cache.keys().next().value);
			}
		}
		cache.set(sku, { expiresAt: now() + ttlMs, product });
	};

	// HTTP only: an unexpected body is a failure of this step, not of the parser.
	async function fetchBatchItems(skus) {
		const response = await http.get(searchUrl(skus), {
			headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
			timeout: timeoutMs,
		});
		if (!Array.isArray(response?.data?.items)) throw new MagentoUnexpectedResponseError(response);
		return response.data.items;
	}

	const openCooldown = () => {
		if (cooldownMs <= 0) return;
		const wasClosed = cooldownUntil <= now();
		cooldownUntil = now() + cooldownMs;
		if (wasClosed) logger.info(`Magento product info: cooldown opened for ${cooldownMs} ms; product cards use the catalog snapshot meanwhile`);
	};

	// { products: Map sku -> product for every SKU Magento knows, degraded }.
	// degraded = not configured, cooldown open, or at least one batch failed.
	async function getProductsBySkus(skus) {
		const products = new Map();
		const unique = [...new Set((Array.isArray(skus) ? skus : []).map((sku) => String(sku ?? '').trim()).filter(Boolean))];
		if (!isConfigured()) return { products, degraded: true };
		if (unique.length === 0) return { products, degraded: false };

		const misses = [];
		for (const sku of unique) {
			const entry = cache.get(sku);
			if (entry && entry.expiresAt > now()) {
				if (entry.product) products.set(sku, entry.product);
			} else {
				if (entry) cache.delete(sku);
				misses.push(sku);
			}
		}
		if (misses.length === 0) return { products, degraded: false };

		if (cooldownUntil > now()) return { products, degraded: true };
		if (cooldownUntil !== 0) {
			cooldownUntil = 0;
			logger.info('Magento product info: cooldown closed, asking the store again');
		}

		let degraded = false;
		const batches = chunk(misses, batchSize);
		for (let index = 0; index < batches.length && !degraded; index += concurrency) {
			const wave = batches.slice(index, index + concurrency);
			const settled = await Promise.allSettled(wave.map((batch) => fetchBatchItems(batch)));
			settled.forEach((outcome, position) => {
				const batch = wave[position];
				if (outcome.status === 'rejected') {
					degraded = true;
					if (isHttpError(outcome.reason)) {
						logger.warn('Magento product info lookup failed; falling back to the catalog table', { ...safeErrorFields(outcome.reason), batchSize: batch.length, skus: batch.slice(0, 5) });
					} else {
						logger.error('Magento product info lookup crashed (not an HTTP failure); falling back to the catalog table', { message: String(outcome.reason?.message || outcome.reason), stack: String(outcome.reason?.stack || ''), skus: batch.slice(0, 5) });
					}
					return;
				}
				let parsed;
				try {
					parsed = outcome.value.map((item) => parseMagentoProduct(item, baseUrl)).filter((product) => product.sku);
				} catch (error) {
					degraded = true;
					logger.error('Magento product info parser failed; falling back to the catalog table', { message: String(error?.message || error), stack: String(error?.stack || ''), skus: batch.slice(0, 5) });
					return;
				}
				const found = new Set();
				for (const product of parsed) {
					remember(product.sku, product);
					found.add(product.sku);
					if (batch.includes(product.sku)) products.set(product.sku, product);
				}
				for (const sku of batch) {
					if (!found.has(sku)) remember(sku, null);
				}
			});
		}
		if (degraded) openCooldown();
		return { products, degraded };
	}

	return { isConfigured, getProductsBySkus, baseUrl, cacheSize: () => cache.size };
}

module.exports = { createMagentoProductInfoClient, parseMagentoProduct, resolveStoreBaseUrl, MagentoUnexpectedResponseError };
