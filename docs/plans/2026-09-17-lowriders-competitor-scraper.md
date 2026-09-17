# Lowriders Competitor Prices (Rough Country) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Lowriders.ca prices for Rough Country SKUs into `CompetitorProduct` every day, through the PartsLogic JSON API, with loud failure and a gated stale delete.

**Architecture:** Pure collector under `lib/competitors/lowriders/` (no Prisma, no env, injected `fetch`) produces a versioned payload. `services/competitors/lowridersIngest.js` (Prisma injected) matches part numbers to `RC-*` products, upserts in batches and deletes stale rows only when a floor passes. `prisma/seeds/seed-individual/seed-lowriders.js` is a thin runner wired to the existing cron, `IngestRun` and log archive.

**Tech Stack:** Node 20 (global `fetch`, `AbortSignal.timeout`), CommonJS, Prisma raw SQL (`jsonb_to_recordset`), `node:test` + `node:assert`, hand-written SQL migration.

**Spec:** `docs/design/dd-018-lowriders-competitor-scraper.md` (read it first; research in `docs/design/dd-018-research-scraping-approaches.md`).

## Global Constraints

- Git: use `/opt/homebrew/bin/git` (the `/usr/bin/git` shim is blocked by the Xcode licence prompt). Work in a worktree on branch `feature/lowriders-competitor-scraper` created from `main`; `main` has unrelated uncommitted edits in `config/cron-jobs.js`, `.env.example`, `lib/feeds/*`, `routes/ingest.js` that must not be committed here. Run `npm ci` in the worktree.
- Never run `npx prisma migrate dev` or `migrate reset`. Local `.env` points at the production database. Locally only `npx prisma validate && npx prisma generate`.
- Never boot the server, never call the database from tests. All tests inject stubs.
- Never read or print `.env*` contents. Never log the PartsLogic API key.
- `config/*.js` modules stay pure: `process.env` and literals only.
- Team artefacts (docs, comments in English, log lines) use plain English, no em-dashes, no user stories.
- No e-mail address hardcoded in the repo (CI blocks it): `SCRAPER_CONTACT_EMAIL` comes from the environment.
- Do not touch `prisma/seeds/api-calls/{tdot-api,partsEngine-api,northridge-api,omix-inventory-api}.js`.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as the last line.
- Run `npm test` (which runs `verify-cron` first) before every commit from Task 9 on; before that, run the task's own test file.

---

## File map

| File | Responsibility |
|------|----------------|
| `test/lib/competitors/fixtures/products-page.json` | 5 raw API items (regular, sale, lossy dealerid, RED variant, zero price) |
| `test/lib/competitors/fixtures/brand-page.html` | the two inline script snippets with a fake key |
| `lib/competitors/lowriders/normalize.js` | raw item to contract row, dedupe, payload builder |
| `lib/competitors/lowriders/discoverConfig.js` | key and groupId from the brand page, env fallback |
| `lib/competitors/skuMatch.js` | canonical part number, product index, match with tie-break |
| `lib/competitors/lowriders/canaries.js` | collection checks and stale floor |
| `lib/competitors/lowriders/partslogicClient.js` | one page request against api.sunhammer.io |
| `lib/competitors/lowriders/collect.js` | orchestration: discover, paginate, normalize, canaries |
| `config/lowriders.js` | env to config object (pure) |
| `prisma/migrations/20260918000000_competitor_product_updated_at_index/migration.sql` | `updated_at` + two indexes |
| `services/competitors/lowridersIngest.js` | resolve competitor, match, batched upsert, gated delete |
| `prisma/seeds/seed-individual/seed-lowriders.js` | thin runner (`--dry-run`) |
| `config/cron-jobs.js`, `config/deploy.yml`, `.env.example` | schedule and env |
| `prisma/seeds/hard-code_data/competitors_data.js` | backfill TDOT + Lowriders |

---

### Task 0: Worktree and baseline

**Files:** none created.

- [ ] **Step 1: Create the worktree** (REQUIRED SUB-SKILL at execution: superpowers:using-git-worktrees)

```bash
cd /Users/ricardotassio/DEV/TRABALHO/JUSTJEEPS/JustJeepsAPI-back-end
/opt/homebrew/bin/git worktree add ../JustJeepsAPI-lowriders -b feature/lowriders-competitor-scraper main
cd ../JustJeepsAPI-lowriders
cp ../JustJeepsAPI-back-end/.env .env   # local env is needed only by `prisma generate`; never print it
npm ci
```

- [ ] **Step 2: Copy the two DD-018 docs into the worktree and commit them**

```bash
cp ../JustJeepsAPI-back-end/docs/design/dd-018-*.md docs/design/
cp ../JustJeepsAPI-back-end/docs/plans/2026-09-17-lowriders-competitor-scraper.md docs/plans/
/opt/homebrew/bin/git add docs/design/dd-018-lowriders-competitor-scraper.md docs/design/dd-018-research-scraping-approaches.md docs/plans/2026-09-17-lowriders-competitor-scraper.md
/opt/homebrew/bin/git commit -m "docs: DD-018 Lowriders competitor prices spec, research and plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Baseline**

Run: `npm test`
Expected: PASS (verify-cron + all suites). If it fails on `main` already, note it and continue; do not fix unrelated tests.

---

### Task 1: Fixtures and `normalize.js`

**Files:**
- Create: `test/lib/competitors/fixtures/products-page.json`
- Create: `lib/competitors/lowriders/normalize.js`
- Test: `test/lib/competitors/normalize.test.js`

**Interfaces:**
- Produces: `normalizeItems(rawList, { maxPrice }) -> { items, invalidCount, invalidSample }`, `dedupeItems(items) -> { items, duplicateCount }`, `buildPayload({ items, runId, capturedAt, reportedTotal, pagesFetched, pageSize, configSource, invalidCount, duplicateCount, brandId }) -> payload` (contract v1, DD-018 section 6). Item shape: `{ sourceId, stockId, competitorSku, partNumber, title, brandName, regularPrice, salePrice, effectivePrice, currency, url, availability }`.

- [ ] **Step 1: Write the fixture**

`test/lib/competitors/fixtures/products-page.json`:

```json
{
  "list": [
    {
      "id": 23910051, "availability": "Available", "brand_name": "Rough Country", "condition": "New",
      "dealerid": "63470", "price": 939.95, "sale": 846.65, "sale_hidden": 0, "stockid": "RCS-63470",
      "title": "63470 | 2.5 Inch Leveling Kit | Spacers | V2 | Jeep Gladiator JT 4WD (20-22)",
      "url": "https://lowriders.ca/i-23910051?", "inventory": 0, "qty": 0, "has_options": false
    },
    {
      "id": 23910052, "availability": "Available", "brand_name": "Rough Country", "condition": "New",
      "dealerid": "699", "price": 112.95, "sale": 0, "sale_hidden": 0, "stockid": "RCS-699",
      "title": "699 | Rough Country Spring Over Pads For Jeep Wrangler YJ 4WD",
      "url": "https://lowriders.ca/i-23910052?", "inventory": 0, "qty": 0, "has_options": false
    },
    {
      "id": 23910053, "availability": "Inventory", "brand_name": "Rough Country", "condition": "New",
      "dealerid": "330.2", "price": 1259.95, "sale": 1137.23, "sale_hidden": 0, "stockid": "RCS-330.20",
      "title": "330.20 | 4 Inch Dodge Suspension Lift Kit w/ Premium N3 Shocks (Dana 44)",
      "url": "https://lowriders.ca/i-23910053?", "inventory": 0, "qty": 0, "has_options": false
    },
    {
      "id": 23910054, "availability": "Available", "brand_name": "Rough Country", "condition": "New",
      "dealerid": "28230RED", "price": 829.95, "sale": 745.61, "sale_hidden": 0, "stockid": "RCS-28230RED",
      "title": "28230RED | Rough Country 3.5 Inch Lift Kit With Red Control Arms",
      "url": "https://lowriders.ca/i-23910054?", "inventory": 0, "qty": 0, "has_options": false
    },
    {
      "id": 23910055, "availability": "Available", "brand_name": "Rough Country", "condition": "New",
      "dealerid": "99999", "price": 0, "sale": 0, "sale_hidden": 0, "stockid": "RCS-99999",
      "title": "99999 | Broken price item",
      "url": "https://lowriders.ca/i-23910055?", "inventory": 0, "qty": 0, "has_options": false
    }
  ],
  "total": 7747
}
```

- [ ] **Step 2: Write the failing test**

`test/lib/competitors/normalize.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/products-page.json');

const { normalizeItems, dedupeItems, buildPayload } = require('../../../lib/competitors/lowriders/normalize');

// The request from sales was explicit: when Lowriders shows a discount, we
// store the discounted price. The API carries it as `sale` (0 = no discount).
test('effective price is the sale price when present, else the regular price', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const sale = items.find((i) => i.competitorSku === '63470');
	const regular = items.find((i) => i.competitorSku === '699');
	assert.strictEqual(sale.regularPrice, 939.95);
	assert.strictEqual(sale.salePrice, 846.65);
	assert.strictEqual(sale.effectivePrice, 846.65);
	assert.strictEqual(regular.salePrice, null);
	assert.strictEqual(regular.effectivePrice, 112.95);
	assert.strictEqual(regular.currency, 'CAD');
});

// dealerid is lossy ("330.2"); stockid keeps the real part number.
test('part number comes from stockid minus the RCS- prefix, keeping dots', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const lossy = items.find((i) => i.stockId === 'RCS-330.20');
	assert.strictEqual(lossy.competitorSku, '330.20');
	assert.strictEqual(lossy.partNumber, '330.20');
	assert.strictEqual(lossy.url, 'https://lowriders.ca/i-23910053?');
	assert.strictEqual(lossy.availability, 'Inventory');
});

test('falls back to the title prefix, then dealerid, when stockid is missing', () => {
	const { items } = normalizeItems(
		[
			{ id: 1, title: '12345 | Something', price: 10, sale: 0, brand_name: 'Rough Country' },
			{ id: 2, dealerid: '777', price: 10, sale: 0, brand_name: 'Rough Country' },
		],
		{ maxPrice: 20000 },
	);
	assert.deepStrictEqual(items.map((i) => i.competitorSku), ['12345', '777']);
});

test('items with no usable price or part number are counted as invalid, not thrown', () => {
	const { items, invalidCount, invalidSample } = normalizeItems(
		[...fixture.list, { id: 9, stockid: 'RCS-1', price: 50000, sale: 0, brand_name: 'Rough Country' }, { id: 10, price: 5 }],
		{ maxPrice: 20000 },
	);
	assert.strictEqual(items.length, 4);
	assert.strictEqual(invalidCount, 3);
	assert.deepStrictEqual(invalidSample.map((s) => s.reason).sort(), ['invalid-price', 'invalid-price', 'no-part-number']);
});

test('dedupe keeps the lowest effective price per competitorSku and counts the rest', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const dup = { ...items[0], sourceId: 1, effectivePrice: 800, salePrice: 800 };
	const result = dedupeItems([...items, dup]);
	assert.strictEqual(result.items.length, 4);
	assert.strictEqual(result.duplicateCount, 1);
	assert.strictEqual(result.items.find((i) => i.competitorSku === '63470').effectivePrice, 800);
});

test('payload carries schemaVersion 1, the competitor, the brand and the collection stats', () => {
	const { items } = normalizeItems(fixture.list, { maxPrice: 20000 });
	const payload = buildPayload({
		items, runId: 42, capturedAt: '2026-09-18T07:13:00.000Z', reportedTotal: 7747,
		pagesFetched: 16, pageSize: 500, configSource: 'page', invalidCount: 1, duplicateCount: 0, brandId: 90296,
	});
	assert.strictEqual(payload.schemaVersion, 1);
	assert.strictEqual(payload.source, 'lowriders');
	assert.deepStrictEqual(payload.competitor, { name: 'Lowriders', website: 'https://www.lowriders.ca/' });
	assert.deepStrictEqual(payload.brand, { name: 'Rough Country', sourceBrandId: 90296 });
	assert.strictEqual(payload.runId, 42);
	assert.strictEqual(payload.collection.reportedTotal, 7747);
	assert.strictEqual(payload.collection.invalidCount, 1);
	assert.strictEqual(payload.items.length, 4);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/lib/competitors/normalize.test.js`
Expected: FAIL with `Cannot find module '../../../lib/competitors/lowriders/normalize'`

- [ ] **Step 4: Write the implementation**

`lib/competitors/lowriders/normalize.js`:

```js
// Raw PartsLogic item -> contract v1 row (DD-018 section 6). Pure: no env, no
// prisma, no I/O. The API returns `price` (regular) and `sale` (discounted or
// 0). Sales asked for the discounted price, so that is the effective one.

const SOURCE = 'lowriders';
const COMPETITOR = { name: 'Lowriders', website: 'https://www.lowriders.ca/' };
const BRAND_NAME = 'Rough Country';
const RCS_PREFIX = /^RCS-/i;
const INVALID_SAMPLE_LIMIT = 25;

function asText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

// stockid ("RCS-330.20") is faithful; dealerid ("330.2") is lossy. Title
// starts with "<part> | " on the listing. Order of trust: stockid, title, dealerid.
function extractPartNumber(raw) {
	const stockid = asText(raw.stockid);
	if (stockid) return stockid.replace(RCS_PREFIX, '');
	const fromTitle = asText(raw.title).split(' | ')[0].trim();
	if (fromTitle) return fromTitle;
	return asText(raw.dealerid);
}

function normalizeItem(raw, { maxPrice }) {
	if (!raw || typeof raw !== 'object') return { item: null, reason: 'not-an-object' };
	const partNumber = extractPartNumber(raw);
	if (!partNumber) return { item: null, reason: 'no-part-number' };

	const regularPrice = asNumber(raw.price);
	const saleValue = asNumber(raw.sale);
	const salePrice = saleValue > 0 ? saleValue : null;
	const effectivePrice = salePrice === null ? regularPrice : salePrice;
	if (!(effectivePrice > 0) || effectivePrice > maxPrice) return { item: null, reason: 'invalid-price' };

	return {
		reason: null,
		item: {
			sourceId: raw.id ?? null,
			stockId: asText(raw.stockid) || null,
			competitorSku: partNumber,
			partNumber,
			title: asText(raw.title),
			brandName: asText(raw.brand_name),
			regularPrice,
			salePrice,
			effectivePrice,
			currency: 'CAD',
			url: asText(raw.url) || null,
			availability: asText(raw.availability) || null,
		},
	};
}

function normalizeItems(rawList, { maxPrice = 20000 } = {}) {
	const items = [];
	const invalidSample = [];
	let invalidCount = 0;
	for (const raw of rawList || []) {
		const { item, reason } = normalizeItem(raw, { maxPrice });
		if (item) {
			items.push(item);
			continue;
		}
		invalidCount += 1;
		if (invalidSample.length < INVALID_SAMPLE_LIMIT) {
			invalidSample.push({ reason, sourceId: raw && raw.id ? raw.id : null, stockId: raw ? asText(raw.stockid) : '' });
		}
	}
	return { items, invalidCount, invalidSample };
}

// Two listings for the same part: keep the cheaper one (that is what a
// customer would see first) and count the duplicate for the canary.
function dedupeItems(items) {
	const bySku = new Map();
	let duplicateCount = 0;
	for (const item of items) {
		const current = bySku.get(item.competitorSku);
		if (!current) {
			bySku.set(item.competitorSku, item);
			continue;
		}
		duplicateCount += 1;
		if (item.effectivePrice < current.effectivePrice) bySku.set(item.competitorSku, item);
	}
	return { items: [...bySku.values()], duplicateCount };
}

function buildPayload({
	items, runId, capturedAt, reportedTotal, pagesFetched, pageSize, configSource, invalidCount, duplicateCount, brandId,
}) {
	return {
		schemaVersion: 1,
		source: SOURCE,
		competitor: { ...COMPETITOR },
		brand: { name: BRAND_NAME, sourceBrandId: brandId },
		runId: runId ?? null,
		capturedAt,
		collection: { reportedTotal, pagesFetched, pageSize, configSource, invalidCount, duplicateCount },
		items,
	};
}

module.exports = { normalizeItem, normalizeItems, dedupeItems, buildPayload, COMPETITOR, BRAND_NAME, SOURCE };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/lib/competitors/normalize.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
/opt/homebrew/bin/git add lib/competitors/lowriders/normalize.js test/lib/competitors/normalize.test.js test/lib/competitors/fixtures/products-page.json
/opt/homebrew/bin/git commit -m "feat(lowriders): normalize PartsLogic items into the contract v1 payload

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `discoverConfig.js`

**Files:**
- Create: `test/lib/competitors/fixtures/brand-page.html`
- Create: `lib/competitors/lowriders/discoverConfig.js`
- Test: `test/lib/competitors/discoverConfig.test.js`

**Interfaces:**
- Produces: `parseWidgetConfig(html) -> { apiKey: string|null, groupId: number|null }`, `discoverConfig({ fetch, brandPageUrl, fallbackApiKey, userAgent, timeoutMs, logger }) -> Promise<{ apiKey, groupId, source: 'page'|'env' }>`; throws an `Error` with `code = 'LOWRIDERS_CONFIG_NOT_FOUND'`.

- [ ] **Step 1: Write the fixture**

`test/lib/competitors/fixtures/brand-page.html` (a fake key, same shape as the live page):

```html
<!doctype html>
<html><head><title>Rough Country | Lowriders</title></head>
<body>
<div id="pl-search-page-container"></div>
<script>
window.addEventListener('DOMContentLoaded', function () {
    window.PartslogicUi.config({ API_KEY: "11111111-2222-3333-4444-555555555555" });
    const searchPageContainer = document.querySelector('#pl-search-page-container');
    const ProductListWrapper = window.PartslogicUi.WsmSearchPage;
    window.ReactDOM.render(
    window.React.createElement(ProductListWrapper, {groupId: 61039}),
    searchPageContainer
    );
})
</script>
</body></html>
```

- [ ] **Step 2: Write the failing test**

`test/lib/competitors/discoverConfig.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseWidgetConfig, discoverConfig } = require('../../../lib/competitors/lowriders/discoverConfig');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/brand-page.html'), 'utf8');
const FAKE_KEY = '11111111-2222-3333-4444-555555555555';
const silent = { info() {}, warn() {}, error() {} };

function fetchStub(status, body) {
	return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

test('parses the API key and groupId out of the brand page', () => {
	assert.deepStrictEqual(parseWidgetConfig(html), { apiKey: FAKE_KEY, groupId: 61039 });
});

test('page without the widget config yields nulls, not a throw', () => {
	assert.deepStrictEqual(parseWidgetConfig('<html></html>'), { apiKey: null, groupId: null });
});

test('discoverConfig prefers the key on the page', async () => {
	const result = await discoverConfig({
		fetch: fetchStub(200, html), brandPageUrl: 'https://x/b', fallbackApiKey: 'env-key', userAgent: 'ua', timeoutMs: 1000, logger: silent,
	});
	assert.deepStrictEqual(result, { apiKey: FAKE_KEY, groupId: 61039, source: 'page' });
});

// The key can rotate or the widget can change shape; the env fallback keeps
// the run alive and the log says where the key came from.
test('discoverConfig falls back to the env key when the page has none', async () => {
	const result = await discoverConfig({
		fetch: fetchStub(200, '<html></html>'), brandPageUrl: 'https://x/b', fallbackApiKey: 'env-key', userAgent: 'ua', timeoutMs: 1000, logger: silent,
	});
	assert.deepStrictEqual(result, { apiKey: 'env-key', groupId: null, source: 'env' });
});

test('discoverConfig fails loudly with a code when neither source has a key, without leaking keys', async () => {
	await assert.rejects(
		discoverConfig({
			fetch: async () => { throw new Error('boom'); }, brandPageUrl: 'https://x/b', fallbackApiKey: '', userAgent: 'ua', timeoutMs: 1000, logger: silent,
		}),
		(err) => err.code === 'LOWRIDERS_CONFIG_NOT_FOUND' && !err.message.includes(FAKE_KEY),
	);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/lib/competitors/discoverConfig.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 4: Write the implementation**

`lib/competitors/lowriders/discoverConfig.js`:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/lib/competitors/discoverConfig.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
/opt/homebrew/bin/git add lib/competitors/lowriders/discoverConfig.js test/lib/competitors/discoverConfig.test.js test/lib/competitors/fixtures/brand-page.html
/opt/homebrew/bin/git commit -m "feat(lowriders): read the PartsLogic key and groupId from the brand page each run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `skuMatch.js`

**Files:**
- Create: `lib/competitors/skuMatch.js`
- Test: `test/lib/competitors/skuMatch.test.js`

**Interfaces:**
- Produces: `canonicalPartNumber(value) -> string`, `buildProductIndex(products) -> Map<string, product[]>` (products are `{ sku, searchable_sku, status }`), `matchPartNumber(index, partNumber) -> { status: 'matched'|'unmatched'|'ambiguous', sku: string|null, candidates: product[] }`.

- [ ] **Step 1: Write the failing test**

`test/lib/competitors/skuMatch.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { canonicalPartNumber, buildProductIndex, matchPartNumber } = require('../../../lib/competitors/skuMatch');

const products = [
	{ sku: 'RC-63470', searchable_sku: '63470', status: 1 },
	{ sku: 'RC-2620_RED', searchable_sku: '2620_RED', status: 1 },
	{ sku: 'RC-330.20', searchable_sku: '330.20', status: 1 },
	{ sku: 'RC-33020', searchable_sku: '33020', status: 1 },
	{ sku: 'RC-10497A', searchable_sku: '10497A', status: 0 },
	{ sku: 'RC-10497-A', searchable_sku: '10497-A', status: 1 },
];

// JJ writes 2620_RED, Parts Engine 2620-RED, Lowriders 28230RED: separators
// differ between sources, dots do not.
test('canonical form drops dashes, underscores and spaces, keeps dots, uppercases', () => {
	assert.strictEqual(canonicalPartNumber(' 2620-red '), '2620RED');
	assert.strictEqual(canonicalPartNumber('2620_RED'), '2620RED');
	assert.strictEqual(canonicalPartNumber('330.20'), '330.20');
	assert.strictEqual(canonicalPartNumber(null), '');
});

test('330.20 and 33020 never collide', () => {
	const index = buildProductIndex(products);
	assert.strictEqual(matchPartNumber(index, '330.20').sku, 'RC-330.20');
	assert.strictEqual(matchPartNumber(index, '33020').sku, 'RC-33020');
});

test('separator variants match the same product', () => {
	const index = buildProductIndex(products);
	assert.strictEqual(matchPartNumber(index, '2620RED').sku, 'RC-2620_RED');
	assert.strictEqual(matchPartNumber(index, '2620-RED').sku, 'RC-2620_RED');
});

test('unknown part numbers are unmatched', () => {
	const index = buildProductIndex(products);
	assert.deepStrictEqual(matchPartNumber(index, 'NOPE'), { status: 'unmatched', sku: null, candidates: [] });
	assert.strictEqual(matchPartNumber(index, '').status, 'unmatched');
});

// Two products share a canonical form: exact raw match wins, then active
// status, then the smallest sku. Deterministic so two runs agree.
test('ambiguous candidates are resolved deterministically and flagged', () => {
	const index = buildProductIndex(products);
	const exact = matchPartNumber(index, '10497A');
	assert.strictEqual(exact.status, 'ambiguous');
	assert.strictEqual(exact.sku, 'RC-10497A');
	assert.strictEqual(exact.candidates.length, 2);

	const noExact = matchPartNumber(index, '10497 A');
	assert.strictEqual(noExact.sku, 'RC-10497-A', 'no raw equality, so the active product wins');
});

test('products without a searchable_sku are ignored by the index', () => {
	const index = buildProductIndex([{ sku: 'RC-X', searchable_sku: null, status: 1 }, { sku: 'RC-Y', searchable_sku: '', status: 1 }]);
	assert.strictEqual(index.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lib/competitors/skuMatch.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the implementation**

`lib/competitors/skuMatch.js`:

```js
// Brand-agnostic part number matcher. Sources disagree on separators
// (2620_RED vs 2620-RED vs 28230RED) but never on dots (330.20 vs 33020 are
// different parts), so the canonical form strips [-_ ] and keeps everything else.

function canonicalPartNumber(value) {
	return String(value ?? '').trim().toUpperCase().replace(/[-_\s]/g, '');
}

function buildProductIndex(products) {
	const index = new Map();
	for (const product of products || []) {
		const key = canonicalPartNumber(product.searchable_sku);
		if (!key) continue;
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(product);
	}
	return index;
}

// Tie-break, in order: raw uppercase equality with searchable_sku, then an
// active product (status 1), then the smallest sku. Same input, same answer.
function pickCandidate(candidates, partNumber) {
	const upper = String(partNumber ?? '').trim().toUpperCase();
	const rank = (p) => [
		String(p.searchable_sku ?? '').toUpperCase() === upper ? 0 : 1,
		p.status === 1 ? 0 : 1,
		String(p.sku ?? ''),
	];
	return [...candidates].sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra[0] !== rb[0]) return ra[0] - rb[0];
		if (ra[1] !== rb[1]) return ra[1] - rb[1];
		return ra[2].localeCompare(rb[2]);
	})[0];
}

function matchPartNumber(index, partNumber) {
	const key = canonicalPartNumber(partNumber);
	const candidates = key ? index.get(key) || [] : [];
	if (candidates.length === 0) return { status: 'unmatched', sku: null, candidates: [] };
	if (candidates.length === 1) return { status: 'matched', sku: candidates[0].sku, candidates };
	return { status: 'ambiguous', sku: pickCandidate(candidates, partNumber).sku, candidates };
}

module.exports = { canonicalPartNumber, buildProductIndex, matchPartNumber };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/lib/competitors/skuMatch.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
/opt/homebrew/bin/git add lib/competitors/skuMatch.js test/lib/competitors/skuMatch.test.js
/opt/homebrew/bin/git commit -m "feat(competitors): part number matcher tolerant to separator variants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `canaries.js`

**Files:**
- Create: `lib/competitors/lowriders/canaries.js`
- Test: `test/lib/competitors/canaries.test.js`

**Interfaces:**
- Produces: `DEFAULT_THRESHOLDS`, `checkCollection({ items, reportedTotal, invalidCount, duplicateCount, thresholds }) -> { ok, failures: [{ code, message, detail }], stats }`, `checkStaleFloor({ matched, previousMatched, thresholds }) -> { ok, reason }`.
- Threshold keys: `minCollectRatio, minItems, maxBrandImpurityRatio, maxInvalidRatio, maxDuplicateRatio, brandName, minMatched, matchDropRatio`.

- [ ] **Step 1: Write the failing test**

`test/lib/competitors/canaries.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { checkCollection, checkStaleFloor, DEFAULT_THRESHOLDS } = require('../../../lib/competitors/lowriders/canaries');

const rc = (n, brand = 'Rough Country') => Array.from({ length: n }, (_, i) => ({ competitorSku: `P${i}`, brandName: brand, effectivePrice: 10 }));
const small = { minItems: 10, minCollectRatio: 0.9, maxBrandImpurityRatio: 0.005, maxInvalidRatio: 0.02, maxDuplicateRatio: 0.01 };
const codes = (r) => r.failures.map((f) => f.code);

// A scraper that returns 12 products instead of 7,747 must not write anything.
test('a healthy collection passes every check', () => {
	const r = checkCollection({ items: rc(100), reportedTotal: 100, invalidCount: 0, duplicateCount: 0, thresholds: small });
	assert.deepStrictEqual(r, { ok: true, failures: [], stats: { collected: 100, reportedTotal: 100, invalidCount: 0, duplicateCount: 0, impure: 0 } });
});

test('TOTAL_MISMATCH fires just under 90% of the reported total and not at 90%', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(89), reportedTotal: 100, thresholds: small })), ['TOTAL_MISMATCH']);
	assert.deepStrictEqual(codes(checkCollection({ items: rc(90), reportedTotal: 100, thresholds: small })), []);
});

test('BELOW_MIN_ITEMS guards against a wrong reported total', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(9), reportedTotal: 9, thresholds: small })), ['BELOW_MIN_ITEMS']);
});

test('BRAND_IMPURE fires above 0.5% foreign items and lists a sample', () => {
	const items = [...rc(199), ...rc(1, 'Other')];
	const r = checkCollection({ items, reportedTotal: 200, thresholds: small });
	assert.deepStrictEqual(codes(r), []);
	const r2 = checkCollection({ items: [...rc(198), ...rc(2, 'Other')], reportedTotal: 200, thresholds: small });
	assert.deepStrictEqual(codes(r2), ['BRAND_IMPURE']);
	assert.strictEqual(r2.failures[0].detail.sample.length, 2);
});

test('PRICE_INVALID_RATIO and DUPLICATE_STOCKIDS use the raw item count', () => {
	assert.deepStrictEqual(codes(checkCollection({ items: rc(97), reportedTotal: 100, invalidCount: 3, thresholds: small })), ['PRICE_INVALID_RATIO']);
	assert.deepStrictEqual(codes(checkCollection({ items: rc(98), reportedTotal: 100, duplicateCount: 2, thresholds: small })), ['DUPLICATE_STOCKIDS']);
});

test('several failures are reported together', () => {
	const r = checkCollection({ items: rc(5, 'Other'), reportedTotal: 100, thresholds: small });
	assert.deepStrictEqual(codes(r).sort(), ['BELOW_MIN_ITEMS', 'BRAND_IMPURE', 'TOTAL_MISMATCH']);
});

test('stale floor needs a minimum and no big drop versus the previous run', () => {
	assert.deepStrictEqual(checkStaleFloor({ matched: 499, previousMatched: null, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, false);
	assert.deepStrictEqual(checkStaleFloor({ matched: 500, previousMatched: null, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }), { ok: true, reason: null });
	assert.strictEqual(checkStaleFloor({ matched: 799, previousMatched: 1000, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, false);
	assert.strictEqual(checkStaleFloor({ matched: 800, previousMatched: 1000, thresholds: { minMatched: 500, matchDropRatio: 0.8 } }).ok, true);
});

test('defaults match the spec', () => {
	assert.strictEqual(DEFAULT_THRESHOLDS.minCollectRatio, 0.9);
	assert.strictEqual(DEFAULT_THRESHOLDS.minItems, 5000);
	assert.strictEqual(DEFAULT_THRESHOLDS.minMatched, 500);
	assert.strictEqual(DEFAULT_THRESHOLDS.matchDropRatio, 0.8);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lib/competitors/canaries.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the implementation**

`lib/competitors/lowriders/canaries.js`:

```js
// Fail-loud checks (DD-018 section 7). Hard canaries run before any write; a
// partial or foreign collection must abort the run, because a silent partial
// write poisons the pricing table far worse than a missing run does.

const DEFAULT_THRESHOLDS = Object.freeze({
	minCollectRatio: 0.9,
	minItems: 5000,
	maxBrandImpurityRatio: 0.005,
	maxInvalidRatio: 0.02,
	maxDuplicateRatio: 0.01,
	brandName: 'Rough Country',
	minMatched: 500,
	matchDropRatio: 0.8,
});

function withDefaults(thresholds) {
	return { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
}

function checkCollection({ items = [], reportedTotal = 0, invalidCount = 0, duplicateCount = 0, thresholds } = {}) {
	const t = withDefaults(thresholds);
	const failures = [];
	const collected = items.length;
	const rawCount = collected + invalidCount + duplicateCount;

	if (reportedTotal > 0 && collected < Math.ceil(reportedTotal * t.minCollectRatio)) {
		failures.push({
			code: 'TOTAL_MISMATCH',
			message: `collected ${collected} of ${reportedTotal} reported (min ratio ${t.minCollectRatio})`,
			detail: { collected, reportedTotal, minCollectRatio: t.minCollectRatio },
		});
	}
	if (collected < t.minItems) {
		failures.push({ code: 'BELOW_MIN_ITEMS', message: `collected ${collected}, minimum ${t.minItems}`, detail: { collected, minItems: t.minItems } });
	}

	const foreign = items.filter((i) => i.brandName !== t.brandName);
	if (collected > 0 && foreign.length / collected > t.maxBrandImpurityRatio) {
		failures.push({
			code: 'BRAND_IMPURE',
			message: `${foreign.length} of ${collected} items are not ${t.brandName}`,
			detail: { impure: foreign.length, sample: foreign.slice(0, 5).map((i) => `${i.competitorSku} (${i.brandName})`) },
		});
	}
	if (rawCount > 0 && invalidCount / rawCount > t.maxInvalidRatio) {
		failures.push({ code: 'PRICE_INVALID_RATIO', message: `${invalidCount} of ${rawCount} items had no usable price or part number`, detail: { invalidCount, rawCount } });
	}
	if (rawCount > 0 && duplicateCount / rawCount > t.maxDuplicateRatio) {
		failures.push({ code: 'DUPLICATE_STOCKIDS', message: `${duplicateCount} of ${rawCount} items were duplicates`, detail: { duplicateCount, rawCount } });
	}

	return {
		ok: failures.length === 0,
		failures,
		stats: { collected, reportedTotal, invalidCount, duplicateCount, impure: foreign.length },
	};
}

// Soft floor: gates only the stale delete. When it fails the prices still
// update; we just refuse to remove rows on the strength of a thin run.
function checkStaleFloor({ matched = 0, previousMatched = null, thresholds } = {}) {
	const t = withDefaults(thresholds);
	if (matched < t.minMatched) return { ok: false, reason: `matched ${matched} is below minMatched ${t.minMatched}` };
	if (previousMatched !== null && previousMatched !== undefined && matched < previousMatched * t.matchDropRatio) {
		return { ok: false, reason: `matched ${matched} dropped below ${t.matchDropRatio} of the previous run (${previousMatched})` };
	}
	return { ok: true, reason: null };
}

module.exports = { DEFAULT_THRESHOLDS, checkCollection, checkStaleFloor };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/lib/competitors/canaries.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
/opt/homebrew/bin/git add lib/competitors/lowriders/canaries.js test/lib/competitors/canaries.test.js
/opt/homebrew/bin/git commit -m "feat(lowriders): fail-loud collection canaries and stale delete floor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `partslogicClient.js` and `collect.js`

**Files:**
- Create: `lib/competitors/lowriders/partslogicClient.js`
- Create: `lib/competitors/lowriders/collect.js`
- Test: `test/lib/competitors/collect.test.js`

**Interfaces:**
- Consumes: Task 1 `normalizeItems/dedupeItems/buildPayload`, Task 2 `discoverConfig`, Task 4 `checkCollection`.
- Produces: `createPartslogicClient({ fetch, apiKey, baseUrl, userAgent, timeoutMs }) -> { fetchPage({ brandId, page, limit }) -> Promise<{ list, total }> }` (errors carry `code` in `LOWRIDERS_KEY_REJECTED | LOWRIDERS_HTTP_ERROR | LOWRIDERS_BAD_BODY | LOWRIDERS_FETCH_FAILED`), `collectLowriders({ fetch, config, runId, logger, sleep, now, withRetry, random }) -> Promise<{ payload, stats, invalidSample, configSource }>`, class `LowridersCollectError` (`.failures`, `.code = 'LOWRIDERS_CANARY_FAILED'`).
- `config` shape: `{ brandPageUrl, apiBaseUrl, brandId, pageSize, pageDelayMs, timeoutMs, userAgent, fallbackApiKey, maxPrice, thresholds }`.

- [ ] **Step 1: Write the failing test**

`test/lib/competitors/collect.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collectLowriders, LowridersCollectError } = require('../../../lib/competitors/lowriders/collect');
const { createPartslogicClient } = require('../../../lib/competitors/lowriders/partslogicClient');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/brand-page.html'), 'utf8');
const fixture = require('./fixtures/products-page.json');
const silent = { info() {}, warn() {}, error() {} };
const noRetry = async (fn) => fn();
const noSleep = async () => {};
const now = () => new Date('2026-09-18T07:13:00.000Z');

const config = {
	brandPageUrl: 'https://www.lowriders.ca/b-90296-rough-country.html?facet-brands=90296',
	apiBaseUrl: 'https://api.sunhammer.io',
	brandId: 90296, pageSize: 2, pageDelayMs: 0, timeoutMs: 1000, userAgent: 'test-ua', fallbackApiKey: '',
	maxPrice: 20000,
	thresholds: { minItems: 3, minCollectRatio: 0.9 },
};

// Serves the brand page and N API pages, records every call.
function makeFetch({ pages, pageStatus = () => 200, total = 4 }) {
	const calls = [];
	const fetch = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers || {} });
		if (url.startsWith(config.brandPageUrl)) return { ok: true, status: 200, text: async () => html };
		const page = Number(new URL(url).searchParams.get('page'));
		const status = pageStatus(page, calls.length);
		if (status !== 200) return { ok: false, status, json: async () => ({ message: 'nope' }) };
		return { ok: true, status: 200, json: async () => ({ list: pages[page - 1] || [], total }) };
	};
	return { fetch, calls };
}

test('client sends the key header and rejects a 404 with LOWRIDERS_KEY_REJECTED', async () => {
	const { fetch, calls } = makeFetch({ pages: [fixture.list], pageStatus: () => 404 });
	const client = createPartslogicClient({ fetch, apiKey: 'k', baseUrl: config.apiBaseUrl, userAgent: 'ua', timeoutMs: 1000 });
	await assert.rejects(client.fetchPage({ brandId: 90296, page: 1, limit: 2 }), (e) => e.code === 'LOWRIDERS_KEY_REJECTED' && !e.message.includes('k'));
	assert.strictEqual(calls[0].headers['sunhammer-api-key'], 'k');
	assert.match(calls[0].url, /brands=90296&limit=2&page=1/);
});

test('collects every page, normalizes and builds the payload', async () => {
	const [a, b, c, d] = fixture.list;
	const { fetch, calls } = makeFetch({ pages: [[a, b], [c, d]], total: 4 });
	const result = await collectLowriders({ fetch, config, runId: 7, logger: silent, sleep: noSleep, now, withRetry: noRetry, random: () => 0 });
	assert.strictEqual(result.payload.items.length, 4);
	assert.strictEqual(result.payload.collection.pagesFetched, 2);
	assert.strictEqual(result.payload.collection.reportedTotal, 4);
	assert.strictEqual(result.payload.collection.configSource, 'page');
	assert.strictEqual(result.payload.runId, 7);
	assert.strictEqual(result.payload.capturedAt, '2026-09-18T07:13:00.000Z');
	assert.strictEqual(calls.length, 3, 'brand page + 2 API pages');
	assert.strictEqual(calls[1].headers['sunhammer-api-key'], '11111111-2222-3333-4444-555555555555');
	assert.strictEqual(calls[1].headers['user-agent'], 'test-ua');
});

test('a short collection aborts before any payload with the canary codes', async () => {
	const { fetch } = makeFetch({ pages: [[fixture.list[0]]], total: 4 });
	await assert.rejects(
		collectLowriders({ fetch, config, runId: 7, logger: silent, sleep: noSleep, now, withRetry: noRetry }),
		(err) => err instanceof LowridersCollectError && err.failures.map((f) => f.code).includes('TOTAL_MISMATCH'),
	);
});

// Key rotated mid-day: the first 404 re-reads the brand page once and retries.
test('a 404 triggers exactly one re-discovery of the key, a second 404 fails', async () => {
	let apiHits = 0;
	const { fetch, calls } = makeFetch({ pages: [fixture.list.slice(0, 4)], total: 4, pageStatus: () => (apiHits++ === 0 ? 404 : 200) });
	const result = await collectLowriders({ fetch, config: { ...config, pageSize: 4 }, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry });
	assert.strictEqual(result.payload.items.length, 4);
	assert.strictEqual(calls.filter((c) => c.url.startsWith(config.brandPageUrl)).length, 2, 'brand page read twice');

	const always404 = makeFetch({ pages: [fixture.list], total: 4, pageStatus: () => 404 });
	await assert.rejects(
		collectLowriders({ fetch: always404.fetch, config, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry }),
		(e) => e.code === 'LOWRIDERS_KEY_REJECTED',
	);
});

test('stops at the reported total even when the last page is full', async () => {
	const { fetch, calls } = makeFetch({ pages: [fixture.list.slice(0, 2), fixture.list.slice(2, 4), [fixture.list[0]]], total: 4 });
	await collectLowriders({ fetch, config, runId: 1, logger: silent, sleep: noSleep, now, withRetry: noRetry });
	assert.strictEqual(calls.filter((c) => c.url.includes('/products')).length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lib/competitors/collect.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the client**

`lib/competitors/lowriders/partslogicClient.js`:

```js
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
```

- [ ] **Step 4: Write the collector**

`lib/competitors/lowriders/collect.js`:

```js
// Orchestration: discover the key, walk the pages politely (concurrency 1,
// jitter), normalize, run the canaries, build the payload. Pure: fetch,
// sleep, now, withRetry and logger are injected so tests need no network.

const { discoverConfig } = require('./discoverConfig');
const { createPartslogicClient } = require('./partslogicClient');
const { normalizeItems, dedupeItems, buildPayload } = require('./normalize');
const { checkCollection } = require('./canaries');

const JITTER_MS = 500;

class LowridersCollectError extends Error {
	constructor(failures) {
		super(`LOWRIDERS_CANARY_FAILED: ${failures.map((f) => `${f.code} (${f.message})`).join('; ')}`);
		this.code = 'LOWRIDERS_CANARY_FAILED';
		this.failures = failures;
	}
}

async function collectLowriders({ fetch, config, runId = null, logger, sleep, now = () => new Date(), withRetry, random = Math.random }) {
	const discoverArgs = {
		fetch, brandPageUrl: config.brandPageUrl, fallbackApiKey: config.fallbackApiKey,
		userAgent: config.userAgent, timeoutMs: config.timeoutMs, logger,
	};
	const clientArgs = { fetch, baseUrl: config.apiBaseUrl, userAgent: config.userAgent, timeoutMs: config.timeoutMs };

	let discovered = await discoverConfig(discoverArgs);
	let client = createPartslogicClient({ ...clientArgs, apiKey: discovered.apiKey });
	let rediscovered = false;

	// A 404 means the key we read is no longer accepted: read the page again
	// once. A second 404 is a real outage and must surface.
	async function fetchPage(page) {
		try {
			return await client.fetchPage({ brandId: config.brandId, page, limit: config.pageSize });
		} catch (err) {
			if (err.code !== 'LOWRIDERS_KEY_REJECTED' || rediscovered) throw err;
			rediscovered = true;
			logger.warn('[lowriders] API key rejected, re-reading the brand page once');
			discovered = await discoverConfig(discoverArgs);
			client = createPartslogicClient({ ...clientArgs, apiKey: discovered.apiKey });
			return client.fetchPage({ brandId: config.brandId, page, limit: config.pageSize });
		}
	}

	const rawItems = [];
	let reportedTotal = 0;
	let pagesFetched = 0;
	let page = 1;
	for (;;) {
		const { list, total } = await withRetry(() => fetchPage(page), `lowriders page ${page}`, { maxRetries: 4, baseDelayMs: 1000 });
		pagesFetched += 1;
		if (page === 1) reportedTotal = total;
		rawItems.push(...list);

		const maxPages = Math.ceil(Math.max(reportedTotal, 1) / config.pageSize) + 1;
		const done = list.length < config.pageSize || page * config.pageSize >= reportedTotal || page >= maxPages;
		if (done) break;
		page += 1;
		await sleep(config.pageDelayMs + Math.floor(random() * JITTER_MS));
	}

	const normalized = normalizeItems(rawItems, { maxPrice: config.maxPrice });
	const deduped = dedupeItems(normalized.items);
	const check = checkCollection({
		items: deduped.items, reportedTotal, invalidCount: normalized.invalidCount, duplicateCount: deduped.duplicateCount, thresholds: config.thresholds,
	});
	logger.info(`[lowriders] step=collect pages=${pagesFetched} items=${deduped.items.length} reportedTotal=${reportedTotal} invalid=${normalized.invalidCount} duplicates=${deduped.duplicateCount} configSource=${discovered.source}`);
	if (!check.ok) {
		for (const failure of check.failures) logger.error(`[lowriders] CANARY FAILED code=${failure.code} detail=${JSON.stringify(failure.detail)}`);
		throw new LowridersCollectError(check.failures);
	}

	const payload = buildPayload({
		items: deduped.items, runId, capturedAt: now().toISOString(), reportedTotal, pagesFetched, pageSize: config.pageSize,
		configSource: discovered.source, invalidCount: normalized.invalidCount, duplicateCount: deduped.duplicateCount, brandId: config.brandId,
	});
	return { payload, stats: check.stats, invalidSample: normalized.invalidSample, configSource: discovered.source };
}

module.exports = { collectLowriders, LowridersCollectError };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/lib/competitors/collect.test.js`
Expected: PASS, 5 tests. If `stops at the reported total` fails, check the `done` condition: with `pageSize 2`, `total 4`, page 2 must be the last one.

- [ ] **Step 6: Run all competitor tests together**

Run: `node --test test/lib/competitors/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
/opt/homebrew/bin/git add lib/competitors/lowriders/partslogicClient.js lib/competitors/lowriders/collect.js test/lib/competitors/collect.test.js
/opt/homebrew/bin/git commit -m "feat(lowriders): pure collector over the PartsLogic products API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Migration and schema

**Files:**
- Create: `prisma/migrations/20260918000000_competitor_product_updated_at_index/migration.sql`
- Modify: `prisma/schema.prisma` (model `CompetitorProduct`, currently lines 520-529)

**Interfaces:**
- Produces: column `"CompetitorProduct"."updated_at"` used by Task 7's UPDATE SQL.

- [ ] **Step 1: Write the migration**

```sql
-- DD-018 Lowriders ingest: row freshness for the gated stale delete, and the
-- two lookups the competitor seeds make (by product, and by competitor + sku).
ALTER TABLE "CompetitorProduct"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "CompetitorProduct_product_sku_idx"
  ON "CompetitorProduct"("product_sku");

CREATE INDEX "CompetitorProduct_competitor_id_competitor_sku_idx"
  ON "CompetitorProduct"("competitor_id", "competitor_sku");
```

- [ ] **Step 2: Edit the schema**

Replace the `CompetitorProduct` model in `prisma/schema.prisma` with:

```prisma
model CompetitorProduct {
  id               Int        @id @default(autoincrement())
  product_sku      String
  competitor_id    Int
  product_url      String?
  competitor_price Float
  competitor_sku   String?
  // DD-018: raw-SQL seeds set updated_at themselves; @updatedAt only covers
  // Prisma client writes.
  updated_at       DateTime   @default(now()) @updatedAt
  competitor       Competitor @relation(fields: [competitor_id], references: [id])
  product          Product    @relation(fields: [product_sku], references: [sku], onDelete: Cascade)

  @@index([product_sku])
  @@index([competitor_id, competitor_sku])
}
```

- [ ] **Step 3: Validate and regenerate (no database contact)**

Run: `npx prisma validate && npx prisma generate`
Expected: `The schema at prisma/schema.prisma is valid` and a generated client. Do NOT run `migrate dev`.

- [ ] **Step 4: Commit**

```bash
/opt/homebrew/bin/git add prisma/migrations/20260918000000_competitor_product_updated_at_index/migration.sql prisma/schema.prisma
/opt/homebrew/bin/git commit -m "feat(db): updated_at and lookup indexes on CompetitorProduct

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `lowridersIngest.js` service

**Files:**
- Create: `services/competitors/lowridersIngest.js`
- Modify: `docs/design/dd-018-lowriders-competitor-scraper.md` section 9.3 (one sentence, see Step 5)
- Test: `test/services/competitors/lowridersIngest.test.js`

**Interfaces:**
- Consumes: Task 3 `buildProductIndex/matchPartNumber`, Task 4 `checkStaleFloor`, payload from Task 5.
- Produces: `ingestLowriders({ prisma, payload, thresholds, logger, dryRun }) -> Promise<{ competitorId, counts: { inserted, updated, deleted, skipped, markedStale }, matched, matchRate, previousMatched, staleFloor: { ok, reason }, unmatchedSample, ambiguousCount, dryRun }>`. Also exports `UPDATE_SQL`, `INSERT_SQL`, `DELETE_SQL`, `UPSERT_BATCH_SIZE` for tests.
- Prisma surface used: `competitor.findFirst/create`, `product.findMany`, `ingestRun.findFirst`, `competitorProduct.count`, `$transaction([...])`, `$executeRawUnsafe(sql, ...params)`.

- [ ] **Step 1: Write the failing test**

`test/services/competitors/lowridersIngest.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { ingestLowriders, UPSERT_BATCH_SIZE } = require('../../../services/competitors/lowridersIngest');

const silent = { info() {}, warn() {}, error() {} };

function item(competitorSku, effectivePrice = 10, url = `https://lowriders.ca/i-${competitorSku}?`) {
	return { competitorSku, partNumber: competitorSku, effectivePrice, url, brandName: 'Rough Country' };
}

function payloadOf(items) {
	return { schemaVersion: 1, source: 'lowriders', competitor: { name: 'Lowriders', website: 'https://www.lowriders.ca/' }, collection: { invalidCount: 2 }, items };
}

// Records every raw statement; $transaction resolves the recorded ops.
function makePrisma({ competitor = { id: 5, name: 'Lowriders' }, products = [], lastRun = null, staleCount = 3, deleteCount = 4 } = {}) {
	const raw = [];
	const created = [];
	return {
		raw,
		created,
		competitor: {
			findFirst: async () => competitor,
			create: async ({ data }) => { created.push(data); return { id: 99, ...data }; },
		},
		product: { findMany: async () => products },
		ingestRun: { findFirst: async () => lastRun },
		competitorProduct: { count: async () => staleCount },
		$executeRawUnsafe(sql, ...params) {
			const op = { sql, params };
			raw.push(op);
			const count = sql.trimStart().startsWith('DELETE') ? deleteCount : sql.includes('UPDATE "CompetitorProduct"') ? 2 : 1;
			return Object.assign(Promise.resolve(count), op);
		},
		$transaction: async (ops) => Promise.all(ops),
	};
}

const products = [
	{ sku: 'RC-63470', searchable_sku: '63470', status: 1 },
	{ sku: 'RC-2620_RED', searchable_sku: '2620_RED', status: 1 },
];

test('matches, upserts in one batch and deletes stale rows when the floor passes', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 1, rowsUpdated: 1 } });
	const result = await ingestLowriders({
		prisma, payload: payloadOf([item('63470', 846.65), item('2620RED', 745.61), item('NOPE')]),
		thresholds: { minMatched: 1, matchDropRatio: 0.8 }, logger: silent,
	});
	assert.strictEqual(result.competitorId, 5);
	assert.strictEqual(result.matched, 2);
	assert.strictEqual(result.counts.skipped, 3, 'one unmatched + two invalid from the collection');
	assert.deepStrictEqual(result.unmatchedSample, ['NOPE']);
	assert.strictEqual(result.staleFloor.ok, true);
	assert.deepStrictEqual(result.counts, { inserted: 1, updated: 2, deleted: 4, skipped: 3, markedStale: 0 });

	const [update, insert, del] = prisma.raw;
	assert.match(update.sql, /UPDATE "CompetitorProduct"/);
	assert.match(update.sql, /updated_at = CURRENT_TIMESTAMP/);
	assert.strictEqual(update.params[0], 5);
	const rows = JSON.parse(update.params[1]);
	assert.deepStrictEqual(rows, [
		{ product_sku: 'RC-63470', competitor_sku: '63470', competitor_price: 846.65, product_url: 'https://lowriders.ca/i-63470?' },
		{ product_sku: 'RC-2620_RED', competitor_sku: '2620RED', competitor_price: 745.61, product_url: 'https://lowriders.ca/i-2620RED?' },
	]);
	assert.match(insert.sql, /INSERT INTO "CompetitorProduct"/);
	assert.match(del.sql, /^\s*DELETE FROM "CompetitorProduct"/);
	assert.deepStrictEqual(JSON.parse(del.params[1]), ['63470', '2620RED']);
});

// A thin run must never delete: prices update, rows stay, the log shouts.
test('when the floor fails the upsert still runs and the delete is skipped', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 100, rowsUpdated: 100 } });
	const warnings = [];
	const result = await ingestLowriders({
		prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1, matchDropRatio: 0.8 }, logger: { ...silent, warn: (m) => warnings.push(m) },
	});
	assert.strictEqual(result.staleFloor.ok, false);
	assert.strictEqual(result.counts.deleted, 0);
	assert.strictEqual(result.counts.markedStale, 3);
	assert.strictEqual(prisma.raw.length, 2, 'update + insert only');
	assert.ok(warnings.some((w) => w.includes('STALE DELETE SKIPPED')));
});

test('a previous success with zero writes (dry run) is not a baseline', async () => {
	const prisma = makePrisma({ products, lastRun: { rowsInserted: 0, rowsUpdated: 0 } });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1 }, logger: silent });
	assert.strictEqual(result.previousMatched, null);
	assert.strictEqual(result.staleFloor.ok, true);
});

test('creates the competitor by name when it is missing', async () => {
	const prisma = makePrisma({ competitor: null, products });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470')]), thresholds: { minMatched: 1 }, logger: silent });
	assert.strictEqual(result.competitorId, 99);
	assert.deepStrictEqual(prisma.created, [{ name: 'Lowriders', website: 'https://www.lowriders.ca/' }]);
});

test('dry run matches and reports but writes nothing and creates nothing', async () => {
	const prisma = makePrisma({ competitor: null, products });
	const result = await ingestLowriders({ prisma, payload: payloadOf([item('63470'), item('X')]), thresholds: { minMatched: 1 }, logger: silent, dryRun: true });
	assert.strictEqual(result.dryRun, true);
	assert.strictEqual(result.matched, 1);
	assert.strictEqual(result.matchRate, 0.5);
	assert.strictEqual(result.competitorId, null);
	assert.strictEqual(prisma.raw.length, 0);
	assert.strictEqual(prisma.created.length, 0);
});

test('upserts in batches of UPSERT_BATCH_SIZE', async () => {
	const many = Array.from({ length: UPSERT_BATCH_SIZE + 1 }, (_, i) => ({ sku: `RC-P${i}`, searchable_sku: `P${i}`, status: 1 }));
	const prisma = makePrisma({ products: many });
	await ingestLowriders({ prisma, payload: payloadOf(many.map((p) => item(p.searchable_sku))), thresholds: { minMatched: 1 }, logger: silent });
	const updates = prisma.raw.filter((op) => op.sql.includes('UPDATE "CompetitorProduct"'));
	assert.strictEqual(updates.length, 2);
	assert.strictEqual(JSON.parse(updates[0].params[1]).length, UPSERT_BATCH_SIZE);
	assert.strictEqual(JSON.parse(updates[1].params[1]).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/services/competitors/lowridersIngest.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the service**

`services/competitors/lowridersIngest.js`:

```js
// Payload (DD-018 section 6) -> CompetitorProduct. Prisma is injected so the
// tests run with a stub. Upsert SQL follows seed-tdot.js (jsonb_to_recordset,
// keyed on competitor_id + competitor_sku); the stale delete only runs when
// the floor passes.

const { buildProductIndex, matchPartNumber } = require('../../lib/competitors/skuMatch');
const { checkStaleFloor } = require('../../lib/competitors/lowriders/canaries');

const UPSERT_BATCH_SIZE = 2000;
const UNMATCHED_SAMPLE = 25;
const AMBIGUOUS_LOG_LIMIT = 50;
const FEED = 'lowriders';

const UPDATE_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      product_sku text, competitor_sku text, competitor_price double precision, product_url text
    )
  )
  UPDATE "CompetitorProduct" cp
  SET product_sku = input.product_sku,
      competitor_price = input.competitor_price,
      product_url = input.product_url,
      updated_at = CURRENT_TIMESTAMP
  FROM input
  WHERE cp.competitor_id = $1 AND cp.competitor_sku = input.competitor_sku;
`;

const INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      product_sku text, competitor_sku text, competitor_price double precision, product_url text
    )
  )
  INSERT INTO "CompetitorProduct" (product_sku, competitor_id, competitor_price, competitor_sku, product_url)
  SELECT input.product_sku, $1, input.competitor_price, input.competitor_sku, input.product_url
  FROM input
  WHERE NOT EXISTS (
    SELECT 1 FROM "CompetitorProduct" cp
    WHERE cp.competitor_id = $1 AND cp.competitor_sku = input.competitor_sku
  );
`;

const DELETE_SQL = `
  DELETE FROM "CompetitorProduct" cp
  WHERE cp.competitor_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text($2::jsonb) s(sku)
      WHERE s.sku = cp.competitor_sku
    );
`;

function chunkArray(items, size) {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

async function resolveCompetitor(prisma, competitor, dryRun) {
	const existing = await prisma.competitor.findFirst({ where: { name: { equals: competitor.name, mode: 'insensitive' } } });
	if (existing) return existing;
	if (dryRun) return null;
	return prisma.competitor.create({ data: { name: competitor.name, website: competitor.website } });
}

function loadRcProducts(prisma) {
	return prisma.product.findMany({
		where: {
			jj_prefix: 'RC',
			searchable_sku: { not: null },
			NOT: [{ searchable_sku: '' }, { searchable_sku: { endsWith: '-' } }],
		},
		select: { sku: true, searchable_sku: true, status: true },
	});
}

// Last successful run with real writes. A success with zero writes is a dry
// run or a broken run, not a baseline.
async function loadPreviousMatched(prisma) {
	const last = await prisma.ingestRun.findFirst({
		where: { feed: FEED, status: 'success' },
		orderBy: { id: 'desc' },
		select: { rowsInserted: true, rowsUpdated: true },
	});
	if (!last) return null;
	const total = (last.rowsInserted || 0) + (last.rowsUpdated || 0);
	return total > 0 ? total : null;
}

async function ingestLowriders({ prisma, payload, thresholds = {}, logger, dryRun = false }) {
	const competitor = await resolveCompetitor(prisma, payload.competitor, dryRun);
	const index = buildProductIndex(await loadRcProducts(prisma));

	const rows = [];
	const unmatched = [];
	const ambiguous = [];
	for (const item of payload.items) {
		const match = matchPartNumber(index, item.partNumber);
		if (match.status === 'unmatched') {
			unmatched.push(item.competitorSku);
			continue;
		}
		if (match.status === 'ambiguous') ambiguous.push({ competitorSku: item.competitorSku, chosen: match.sku, candidates: match.candidates.map((c) => c.sku) });
		rows.push({ product_sku: match.sku, competitor_sku: item.competitorSku, competitor_price: item.effectivePrice, product_url: item.url || null });
	}

	const matched = rows.length;
	const matchRate = payload.items.length ? matched / payload.items.length : 0;
	logger.info(`[lowriders] step=match matched=${matched} unmatched=${unmatched.length} ambiguous=${ambiguous.length} matchRate=${matchRate.toFixed(3)}`);
	if (unmatched.length) logger.info(`[lowriders] unmatched sample: ${unmatched.slice(0, UNMATCHED_SAMPLE).join(', ')}`);
	for (const a of ambiguous.slice(0, AMBIGUOUS_LOG_LIMIT)) logger.warn(`[lowriders] ambiguous ${a.competitorSku} -> ${a.chosen} (candidates: ${a.candidates.join(', ')})`);

	const previousMatched = await loadPreviousMatched(prisma);
	const staleFloor = checkStaleFloor({ matched, previousMatched, thresholds });
	const counts = { inserted: 0, updated: 0, deleted: 0, skipped: unmatched.length + (payload.collection?.invalidCount || 0), markedStale: 0 };
	const summary = {
		competitorId: competitor ? competitor.id : null, counts, matched, matchRate, previousMatched, staleFloor,
		unmatchedSample: unmatched.slice(0, UNMATCHED_SAMPLE), ambiguousCount: ambiguous.length, dryRun,
	};

	if (dryRun) {
		logger.info('[lowriders] dry-run: no writes');
		return summary;
	}

	for (const batch of chunkArray(rows, UPSERT_BATCH_SIZE)) {
		const json = JSON.stringify(batch);
		const [updated, inserted] = await prisma.$transaction([
			prisma.$executeRawUnsafe(UPDATE_SQL, competitor.id, json),
			prisma.$executeRawUnsafe(INSERT_SQL, competitor.id, json),
		]);
		counts.updated += Number(updated) || 0;
		counts.inserted += Number(inserted) || 0;
	}
	logger.info(`[lowriders] step=upsert inserted=${counts.inserted} updated=${counts.updated}`);

	const writtenSkus = rows.map((r) => r.competitor_sku);
	if (staleFloor.ok) {
		counts.deleted = Number(await prisma.$executeRawUnsafe(DELETE_SQL, competitor.id, JSON.stringify(writtenSkus))) || 0;
		logger.info(`[lowriders] step=stale deleted=${counts.deleted} floor=passed`);
	} else {
		counts.markedStale = await prisma.competitorProduct.count({ where: { competitor_id: competitor.id, competitor_sku: { notIn: writtenSkus } } });
		logger.warn(`[lowriders] STALE DELETE SKIPPED: ${staleFloor.reason} (${counts.markedStale} rows kept)`);
	}

	return summary;
}

module.exports = { ingestLowriders, UPDATE_SQL, INSERT_SQL, DELETE_SQL, UPSERT_BATCH_SIZE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/services/competitors/lowridersIngest.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Align the spec with the delete key**

In `docs/design/dd-018-lowriders-competitor-scraper.md`, section 9.3, replace the sentence `` `$2` is the JSON array of every `competitorSku` seen in this run (about 7,700 strings). `` with `` `$2` is the JSON array of every `competitor_sku` written in this run (matched items only, about 7,700 strings). Rows for parts that are listed but no longer match one of our products are removed too, because a row we cannot match is a row we cannot trust. ``

- [ ] **Step 6: Commit**

```bash
/opt/homebrew/bin/git add services/competitors/lowridersIngest.js test/services/competitors/lowridersIngest.test.js docs/design/dd-018-lowriders-competitor-scraper.md
/opt/homebrew/bin/git commit -m "feat(lowriders): ingest service with batched upsert and gated stale delete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `config/lowriders.js` and the thin runner

**Files:**
- Create: `config/lowriders.js`
- Rewrite: `prisma/seeds/seed-individual/seed-lowriders.js`
- Delete: `prisma/seeds/api-calls/lowriders.js`
- Test: `test/config/lowriders.test.js`

**Interfaces:**
- Consumes: Task 5 `collectLowriders/LowridersCollectError`, Task 7 `ingestLowriders`, `lib/ingest/ingestRun.startRun`, `lib/ingest/withRetry.withRetry`, `services/logArchive/logArchiveService.createLogArchive`.
- Produces: `getLowridersConfig(env) -> { brandPageUrl, apiBaseUrl, brandId, pageSize, pageDelayMs, timeoutMs, userAgent, fallbackApiKey, maxPrice, thresholds, contactEmail }`; npm script `seed-lowriders` (unchanged name) with `--dry-run`.

- [ ] **Step 1: Write the failing config test**

`test/config/lowriders.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { getLowridersConfig } = require('../../config/lowriders');

test('defaults match DD-018 and the User-Agent carries the contact', () => {
	const c = getLowridersConfig({ SCRAPER_CONTACT_EMAIL: 'ops@example.test' });
	assert.strictEqual(c.brandId, 90296);
	assert.strictEqual(c.pageSize, 500);
	assert.strictEqual(c.pageDelayMs, 750);
	assert.strictEqual(c.timeoutMs, 30000);
	assert.strictEqual(c.maxPrice, 20000);
	assert.strictEqual(c.apiBaseUrl, 'https://api.sunhammer.io');
	assert.match(c.brandPageUrl, /^https:\/\/www\.lowriders\.ca\/b-90296-rough-country\.html/);
	assert.strictEqual(c.userAgent, 'JustJeepsPriceMonitor/1.0 (+ops@example.test)');
	assert.strictEqual(c.thresholds.minMatched, 500);
	assert.strictEqual(c.fallbackApiKey, '');
});

test('env overrides are parsed and clamped', () => {
	const c = getLowridersConfig({
		SCRAPER_CONTACT_EMAIL: 'x@y.test', LOWRIDERS_PAGE_SIZE: '5000', LOWRIDERS_MIN_MATCHED: '1200',
		LOWRIDERS_MIN_COLLECT_RATIO: '0.95', LOWRIDERS_PARTSLOGIC_API_KEY: 'k', LOWRIDERS_PAGE_DELAY_MS: 'abc',
	});
	assert.strictEqual(c.pageSize, 1000, 'API max verified at 1000');
	assert.strictEqual(c.thresholds.minMatched, 1200);
	assert.strictEqual(c.thresholds.minCollectRatio, 0.95);
	assert.strictEqual(c.fallbackApiKey, 'k');
	assert.strictEqual(c.pageDelayMs, 750, 'garbage falls back to the default');
});

test('missing contact e-mail is a startup error', () => {
	assert.throws(() => getLowridersConfig({}), /SCRAPER_CONTACT_EMAIL/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config/lowriders.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the config module**

`config/lowriders.js`:

```js
// Lowriders competitor prices (DD-018): env -> config for the collector and
// the ingest floor. Pure: process.env and literals only, same rule as
// config/cron-jobs.js, so tests and verify scripts can load it.

const DEFAULTS = Object.freeze({
	brandPageUrl: 'https://www.lowriders.ca/b-90296-rough-country.html?facet-brands=90296',
	apiBaseUrl: 'https://api.sunhammer.io',
	brandId: 90296,
	pageSize: 500,
	pageDelayMs: 750,
	timeoutMs: 30000,
	maxPrice: 20000,
	minCollectRatio: 0.9,
	minItems: 5000,
	minMatched: 500,
	matchDropRatio: 0.8,
});

const PAGE_SIZE_MAX = 1000; // verified against the API on 2026-09-17

function intFrom(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

function ratioFrom(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

function getLowridersConfig(env = process.env) {
	const contactEmail = String(env.SCRAPER_CONTACT_EMAIL || '').trim();
	if (!contactEmail) throw new Error('SCRAPER_CONTACT_EMAIL is required: it identifies us in the scraper User-Agent');

	return {
		brandPageUrl: env.LOWRIDERS_BRAND_PAGE_URL || DEFAULTS.brandPageUrl,
		apiBaseUrl: env.LOWRIDERS_API_BASE_URL || DEFAULTS.apiBaseUrl,
		brandId: intFrom(env.LOWRIDERS_BRAND_ID, DEFAULTS.brandId, 1, Number.MAX_SAFE_INTEGER),
		pageSize: intFrom(env.LOWRIDERS_PAGE_SIZE, DEFAULTS.pageSize, 20, PAGE_SIZE_MAX),
		pageDelayMs: intFrom(env.LOWRIDERS_PAGE_DELAY_MS, DEFAULTS.pageDelayMs, 0, 60000),
		timeoutMs: intFrom(env.LOWRIDERS_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 120000),
		maxPrice: intFrom(env.LOWRIDERS_MAX_PRICE, DEFAULTS.maxPrice, 1, 1000000),
		fallbackApiKey: String(env.LOWRIDERS_PARTSLOGIC_API_KEY || '').trim(),
		contactEmail,
		userAgent: `JustJeepsPriceMonitor/1.0 (+${contactEmail})`,
		thresholds: {
			minCollectRatio: ratioFrom(env.LOWRIDERS_MIN_COLLECT_RATIO, DEFAULTS.minCollectRatio),
			minItems: intFrom(env.LOWRIDERS_MIN_ITEMS, DEFAULTS.minItems, 0, Number.MAX_SAFE_INTEGER),
			minMatched: intFrom(env.LOWRIDERS_MIN_MATCHED, DEFAULTS.minMatched, 0, Number.MAX_SAFE_INTEGER),
			matchDropRatio: ratioFrom(env.LOWRIDERS_MATCH_DROP_RATIO, DEFAULTS.matchDropRatio),
		},
	};
}

module.exports = { getLowridersConfig, DEFAULTS };
```

- [ ] **Step 4: Run the config test**

Run: `node --test test/config/lowriders.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rewrite the runner**

Replace the whole content of `prisma/seeds/seed-individual/seed-lowriders.js` with:

```js
// Lowriders competitor prices for Rough Country (DD-018). Thin runner: env ->
// config, IngestRun bookkeeping, collect, snapshot, ingest, exit code. All the
// logic lives in lib/competitors/lowriders (pure) and
// services/competitors/lowridersIngest (prisma injected).
//
//   npm run seed-lowriders              # collect + write
//   npm run seed-lowriders -- --dry-run # collect + match report, no writes

const fs = require('fs');
const path = require('path');

const prisma = require('../../../lib/prisma');
const { startRun } = require('../../../lib/ingest/ingestRun');
const { withRetry } = require('../../../lib/ingest/withRetry');
const { collectLowriders, LowridersCollectError } = require('../../../lib/competitors/lowriders/collect');
const { ingestLowriders } = require('../../../services/competitors/lowridersIngest');
const { createLogArchive } = require('../../../services/logArchive/logArchiveService');
const { getLowridersConfig } = require('../../../config/lowriders');

const FEED = 'lowriders';
const COMMAND = 'seed-lowriders';
const SNAPSHOT_DIR = path.join(__dirname, '..', 'logs', 'lowriders');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'latest-snapshot.json');

const stamp = () => new Date().toISOString();
const logger = {
	info: (m) => console.log(`[${stamp()}] ${m}`),
	warn: (m) => console.warn(`[${stamp()}] ${m}`),
	error: (m) => console.error(`[${stamp()}] ${m}`),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeSnapshot(payload) {
	fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
	fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
	return SNAPSHOT_FILE;
}

async function archiveSnapshot(filePath, startedAt, status) {
	try {
		const archive = createLogArchive({ logger });
		const result = await archive.archiveFile({ filePath, command: COMMAND, startedAt, status, source: process.env.INGEST_TRIGGER || 'cron', extension: 'json' });
		logger.info(`[lowriders] snapshot archive: ${result.archived ? result.key : `skipped (${result.reason})`}`);
	} catch (err) {
		logger.warn(`[lowriders] snapshot archive failed: ${err.message}`);
	}
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const config = getLowridersConfig(process.env);
	const startedAt = new Date();
	const run = await startRun(FEED, { sourceKind: 'api', sourceRef: config.brandPageUrl, startedBy: process.env.INGEST_TRIGGER || 'cron' });
	logger.info(`[lowriders] run ${run.id} started${dryRun ? ' (dry-run)' : ''} brand=${config.brandId} pageSize=${config.pageSize}`);

	let status = 'failed';
	try {
		const { payload, invalidSample } = await collectLowriders({ fetch, config, runId: run.id, logger, sleep, withRetry });
		if (invalidSample.length) logger.info(`[lowriders] invalid sample: ${JSON.stringify(invalidSample.slice(0, 10))}`);

		const snapshotPath = writeSnapshot(payload);
		const result = await ingestLowriders({ prisma, payload, thresholds: config.thresholds, logger, dryRun });

		status = 'success';
		await run.finish({ status, counts: result.counts, sourceRowCount: payload.items.length });
		await archiveSnapshot(snapshotPath, startedAt, status);
		logger.info(`[lowriders] run ${run.id} finished: matched=${result.matched} matchRate=${result.matchRate.toFixed(3)} inserted=${result.counts.inserted} updated=${result.counts.updated} deleted=${result.counts.deleted} skipped=${result.counts.skipped}${dryRun ? ' (dry-run, nothing written)' : ''}`);
		process.exitCode = 0;
	} catch (err) {
		const detail = err instanceof LowridersCollectError ? err.failures.map((f) => f.code).join(',') : err.code || err.message;
		logger.error(`[lowriders] run ${run.id} FAILED: ${err.message}`);
		await run.finish({ status: 'failed', error: detail });
		process.exitCode = 1;
	}
}

main()
	.catch((err) => {
		console.error(`[${stamp()}] [lowriders] fatal: ${err.message}`);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
```

- [ ] **Step 6: Delete the ParseHub fetcher and make sure nothing else imports it**

```bash
/opt/homebrew/bin/git rm prisma/seeds/api-calls/lowriders.js
grep -rn "api-calls/lowriders" --include=*.js . | grep -v node_modules
```
Expected: the grep prints nothing.

- [ ] **Step 7: Smoke the runner without network or database**

Run: `node -e "require('./config/lowriders').getLowridersConfig({SCRAPER_CONTACT_EMAIL:'a@b.test'}); console.log('config ok')" && node --check prisma/seeds/seed-individual/seed-lowriders.js && echo "syntax ok"`
Expected: `config ok` and `syntax ok`. Do not execute the seed locally (it would write to the shared production database).

- [ ] **Step 8: Commit**

```bash
/opt/homebrew/bin/git add config/lowriders.js test/config/lowriders.test.js prisma/seeds/seed-individual/seed-lowriders.js
/opt/homebrew/bin/git commit -m "feat(lowriders): thin seed runner over the collector and ingest service, drop the ParseHub fetch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Cron, deploy and env wiring

**Files:**
- Modify: `config/cron-jobs.js` (append a const pair near line 45, a job entry after the `feed-prune-apply` entry near line 178, two names in the `config` export near line 305)
- Modify: `config/deploy.yml` (two `env.clear` lines after `CRON_FEEDS_PRUNE_SCHEDULE` at line 152; two `env.secret` names after `PARSEHUB_KEY_NORTHRIDGE` at line 249)
- Modify: `.env.example` (append a block at the end)

**Interfaces:**
- Consumes: npm script `seed-lowriders` (exists at `package.json:66`).

- [ ] **Step 1: Add the cron definition**

In `config/cron-jobs.js`, right after the `feedsPruneSchedule` line:

```js
// Lowriders competitor prices (DD-018): public JSON API, 8 to 16 requests a
// day. Opt-in; 03:13 is off the orders-delta grid and hours before seed-all.
const lowridersSeedEnabled = process.env.CRON_SEED_LOWRIDERS_ENABLED === 'true';
const lowridersSeedSchedule = process.env.CRON_SEED_LOWRIDERS_SCHEDULE || '13 3 * * *';
```

In `getCronJobDefinitions()`, right after the `feed-prune-apply` entry:

```js
		{
			enabled: lowridersSeedEnabled,
			schedule: lowridersSeedSchedule,
			command: 'seed-lowriders',
			jobName: 'Lowriders Competitor Prices',
			logPrefix: 'Lowriders competitor prices',
			reportLogFile: 'prisma/seeds/logs/seed-lowriders.log',
		},
```

In the `config` export object, right after `feedsPruneSchedule,`:

```js
		lowridersSeedEnabled,
		lowridersSeedSchedule,
```

- [ ] **Step 2: Mirror in `config/deploy.yml`**

After the `CRON_FEEDS_PRUNE_SCHEDULE` line (env.clear):

```yaml
    # Lowriders competitor prices (DD-018). Off until the dry run in
    # production sets LOWRIDERS_MIN_MATCHED.
    CRON_SEED_LOWRIDERS_ENABLED: "false"
    CRON_SEED_LOWRIDERS_SCHEDULE: "13 3 * * *"
```

After `- PARSEHUB_KEY_NORTHRIDGE` (env.secret):

```yaml
    # Lowriders scraper (DD-018): contact goes in the User-Agent, key is a fallback only
    - SCRAPER_CONTACT_EMAIL
    - LOWRIDERS_PARTSLOGIC_API_KEY
    - LOWRIDERS_MIN_MATCHED
```

- [ ] **Step 3: Append to `.env.example`**

```
# =============================================================================
# LOWRIDERS COMPETITOR PRICES (docs/design/dd-018-lowriders-competitor-scraper.md)
# Public JSON API behind the lowriders.ca listing. Defaults in config/lowriders.js.
# =============================================================================
CRON_SEED_LOWRIDERS_ENABLED=false
# CRON_SEED_LOWRIDERS_SCHEDULE=13 3 * * *
SCRAPER_CONTACT_EMAIL=          # required: goes in the User-Agent so the site can reach us
# LOWRIDERS_PARTSLOGIC_API_KEY= # fallback only; the key is read from the brand page each run
# LOWRIDERS_PAGE_SIZE=500       # up to 1000
# LOWRIDERS_PAGE_DELAY_MS=750
# LOWRIDERS_REQUEST_TIMEOUT_MS=30000
# LOWRIDERS_MIN_COLLECT_RATIO=0.9
# LOWRIDERS_MIN_ITEMS=5000
# LOWRIDERS_MAX_PRICE=20000
# LOWRIDERS_MIN_MATCHED=500     # set from the first --dry-run in production
# LOWRIDERS_MATCH_DROP_RATIO=0.8
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `verify-cron` passes (script exists, schedule valid, deploy.yml schedule valid) and every suite passes.

- [ ] **Step 5: Commit**

```bash
/opt/homebrew/bin/git add config/cron-jobs.js config/deploy.yml .env.example
/opt/homebrew/bin/git commit -m "feat(lowriders): daily cron job (opt-in), deploy env and example env

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Competitor seed backfill

**Files:**
- Modify: `prisma/seeds/hard-code_data/competitors_data.js`

- [ ] **Step 1: Append the two competitors that exist in production but not in the seed**

Replace the array with:

```js
// competitors_data.js
//
// Order matters: ids come from the autoincrement sequence, and production has
// TDOT as 4 and Lowriders as 5 (inserted by hand before this file caught up).
// seed-hard-code matches by name, so re-running it never duplicates a row.

const competitorsData = [
  {
    name: "Northridge 4x4",
    website: "https://www.northridge4x4.ca/",
  },
  {
    name: "GTA Jeeps & Trucks",
    website: "https://www.gtajeeps.ca/",
  },
  {
    name: "Parts Engine",
    website: "https://www.partsengine.ca/",
  },
  {
    name: "TDOT",
    website: "https://www.tdotperformance.ca/",
  },
  {
    name: "Lowriders",
    website: "https://www.lowriders.ca/",
  },
];

module.exports = competitorsData;
```

Before committing, confirm the TDOT website against the production row (read-only, run by the user in the panel or `psql`): `SELECT id, name, website FROM "Competitor" ORDER BY id;`. If the production name differs from `TDOT` (the front-end matches `"TDOT"` exactly), use the production value.

- [ ] **Step 2: Load check**

Run: `node -e "console.log(require('./prisma/seeds/hard-code_data/competitors_data').map(c => c.name))"`
Expected: the five names in order.

- [ ] **Step 3: Commit**

```bash
/opt/homebrew/bin/git add prisma/seeds/hard-code_data/competitors_data.js
/opt/homebrew/bin/git commit -m "chore(seeds): backfill TDOT and Lowriders in the competitor seed data

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Front-end deep link (optional, separate repo)

**Files:**
- Modify: `/Users/ricardotassio/DEV/TRABALHO/JUSTJEEPS/JustJeepsAPI-front-end/src/features/items/ProductTable.jsx` (the `else if` chain at lines 241-265)

- [ ] **Step 1: Add one branch, no restyle**

After the `4wp` branch, add:

```jsx
					} else if (competitorName.includes('lowriders') && competitorProduct.product_url) {
						link = competitorProduct.product_url;
```

- [ ] **Step 2: Lint and test the front-end**

Run (in the front-end repo): `npm run lint && npm test`
Expected: PASS. The front-end deploys by hand from the DigitalOcean panel, followed by a Cloudflare purge (see memory note on front-end deploys).

- [ ] **Step 3: Commit in the front-end repo**

```bash
cd /Users/ricardotassio/DEV/TRABALHO/JUSTJEEPS/JustJeepsAPI-front-end
/opt/homebrew/bin/git add src/features/items/ProductTable.jsx
/opt/homebrew/bin/git commit -m "feat(items): link the Lowriders competitor price to their product page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Finish the branch and rollout notes

- [ ] **Step 1: Final verification in the worktree**

Run: `npm test && npx prisma validate`
Expected: all green.

- [ ] **Step 2: Hand off** (REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch)

Merge or open the PR from `feature/lowriders-competitor-scraper`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Rollout (production, done by the user)**

1. Deploy with Kamal (`set -a; source .env.production; set +a; kamal deploy`): the migration applies in the entrypoint.
2. Set `SCRAPER_CONTACT_EMAIL` in `.env.production` before the deploy (the runner refuses to start without it).
3. `kamal app exec 'npm run seed-lowriders -- --dry-run'` and read `matchRate` and `matched` from the log.
4. Set `LOWRIDERS_MIN_MATCHED` to about 80% of `matched`, set `CRON_SEED_LOWRIDERS_ENABLED: "true"` in `config/deploy.yml`, redeploy.
5. Check the first real run in the cron panel and at `GET /api/ingest/runs?feed=lowriders`.

---

## Self-review (done while writing)

- Spec coverage: sections 5 (modules) → Tasks 1-8; 6 (contract) → Task 1; 7 (canaries, floor) → Tasks 4, 7; 8 (matching) → Task 3; 9.1-9.3 (DB) → Tasks 6, 7; 9.4 (competitor row, backfill) → Tasks 7, 10; 9.5 (cron, env) → Tasks 8, 9; 10 (observability) → Tasks 7, 8; 11 (tests) → every task; 12 (front-end link) → Task 11; 13 rollout → Task 12; ParseHub file removal → Task 8. Section 12 of the spec (external service) is a discussion, no task.
- Placeholders: none. Every code step has full code.
- Type consistency: `normalizeItems` returns `{ items, invalidCount, invalidSample }` (Tasks 1, 5); `collectLowriders` returns `{ payload, stats, invalidSample, configSource }` (Tasks 5, 8); `ingestLowriders` returns `{ competitorId, counts, matched, matchRate, previousMatched, staleFloor, unmatchedSample, ambiguousCount, dryRun }` (Tasks 7, 8); `checkStaleFloor` returns `{ ok, reason }` (Tasks 4, 7); config keys match between `config/lowriders.js` and `collect.js` (`brandPageUrl, apiBaseUrl, brandId, pageSize, pageDelayMs, timeoutMs, userAgent, fallbackApiKey, maxPrice, thresholds`).
