const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defineStoreProfile } = require('../../../../lib/competitors/shopify/profile');
const { createSnapshot } = require('../../../../lib/competitors/shopify/snapshot');
const { createCollector } = require('../../../../lib/competitors/shopify/collect');
const { snapshotFiles } = require('../../../../services/competitors/shopifyCompetitorDeps');

const spec = {
	key: 'shopx', errorPrefix: 'SHOPX', shortName: 'Shop X', competitor: { name: 'Shop X', website: 'https://shopx.test/' },
	mapping: { handleField: 'shopx_code', prefixesField: 'shopx_sku_prefixes' }, purity: 'sku-code',
};
const quiet = { info() {}, warn() {}, error() {} };

test('a gzip profile names its snapshots .json.gz, the latest one included', () => {
	const gz = createSnapshot(defineStoreProfile({ ...spec, gzipSnapshots: true }));
	assert.strictEqual(gz.snapshotFileName({ runId: 4, dryRun: true, stamp: 's' }), 'shopx-run-4-dry-run-s.json.gz');
	assert.strictEqual(gz.snapshotFileName({ runId: null, stamp: 's' }), 'shopx-collect-s.json.gz');
	assert.strictEqual(gz.latestSnapshotName, 'latest-snapshot.json.gz');
	assert.strictEqual(createSnapshot(defineStoreProfile(spec)).latestSnapshotName, 'latest-snapshot.json');
});

test('snapshot files are gzipped by name and read back the same, plain json untouched', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopx-snap-'));
	try {
		const { writeFile, readFile } = snapshotFiles();
		const body = JSON.stringify({ items: [{ a: 1 }] });
		writeFile(path.join(dir, 'nested', 'a.json.gz'), body);
		writeFile(path.join(dir, 'b.json'), body);
		assert.strictEqual(readFile(path.join(dir, 'nested', 'a.json.gz')), body);
		assert.strictEqual(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), body);
		assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'nested', 'a.json.gz')).subarray(0, 2)], [0x1f, 0x8b]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a store with a 40-page index trusts a 22-page collections index and checks handles against it', async () => {
	const profile = defineStoreProfile({ ...spec, maxIndexPages: 40 });
	const fetch = async (url) => {
		const { pathname, searchParams } = new URL(url);
		const page = Number(searchParams.get('page'));
		let body = { products: [] };
		if (pathname === '/collections.json') {
			const count = page < 22 ? 250 : page === 22 ? 145 : 0;
			body = { collections: Array.from({ length: count }, (_, i) => ({ handle: page === 22 && i === 0 ? 'warn' : `c-${page}-${i}`, products_count: 1 })) };
		}
		if (pathname === '/collections/warn/products.json') body = { products: [{ id: 1, handle: 'w', vendor: 'Warn', variants: [{ id: 2, sku: 'BCSQ_1', price: '5' }] }] };
		return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) };
	};
	const config = {
		baseUrl: 'https://shopx.test', userAgent: 'ua', timeoutMs: 1000, pageSize: 250, maxPrice: 20000, requestDelayMs: 0, jitterMs: 0,
		maxAttempts: 1, backoffMs: 0, retryAfterCapMs: 0, challengeRetryDelayMs: 0, consecutiveFailureLimit: 5, maxRequests: 100,
		maxRunMinutes: 60, maxPagesPerBrand: 10,
		thresholds: { minItems: 1, minMatched: 1, maxFailedRequestRatio: 0.5, maxBrandsFailedRatio: 0.6, maxInvalidRatio: 0.5, matchDropRatio: 0.8 },
	};
	const brands = [{ jjPrefix: 'WAR', handle: 'warn', skuPrefixes: ['BCSQ_'] }, { jjPrefix: 'XX', handle: 'gone', skuPrefixes: ['XXXX_'] }];
	const { payload } = await createCollector(profile)({ fetch, config, brands, logger: quiet, sleep: async () => {}, random: () => 0 });
	assert.deepStrictEqual(payload.brandStats.map((b) => [b.jjPrefix, b.status, b.expectedCount]), [['WAR', 'ok', 1], ['XX', 'missing-handle', null]]);
});
