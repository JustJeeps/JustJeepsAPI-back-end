const test = require('node:test');
const assert = require('node:assert');

const { planLabels } = require('../../../../lib/competitors/tdot/plan');

const labels = [
	{ label: 'Bestop', total: 780, ourProducts: 300 },
	{ label: 'Covercraft', total: 92560, ourProducts: 40 },
	{ label: 'Smittybilt', total: 2, ourProducts: 900 },
	{ label: 'Nowhere', total: 0, ourProducts: 10 },
	{ label: 'Tiny', total: 120, ourProducts: 1 },
];

test('planLabels crawls small labels and queries per product when that is cheaper or the label is huge', () => {
	const plan = planLabels(labels, { pageSize: 100, brandCrawlMaxItems: 10000 });
	assert.deepStrictEqual(plan.map((p) => [p.label, p.mode, p.requests]), [
		['Bestop', 'crawl', 8],
		['Covercraft', 'per-product', 40],
		['Smittybilt', 'crawl', 1],
		['Nowhere', 'skip', 0],
		['Tiny', 'per-product', 1],
	]);
});

test('planLabels reports the total request budget and respects a hard cap by dropping the most expensive labels last', () => {
	const plan = planLabels(labels, { pageSize: 100, brandCrawlMaxItems: 10000, maxRequests: 10 });
	const kept = plan.filter((p) => p.mode !== 'skip' && p.mode !== 'over-budget');
	assert.ok(kept.reduce((sum, p) => sum + p.requests, 0) <= 10);
	assert.deepStrictEqual(plan.find((p) => p.label === 'Covercraft').mode, 'over-budget');
	assert.deepStrictEqual(plan.find((p) => p.label === 'Bestop').mode, 'crawl');
});

test('planLabels queries a perProductOnly label per product, even when its label search is small or empty', () => {
	const plan = planLabels([
		{ label: 'Fuel', total: 23000, ourProducts: 75, perProductOnly: true },
		{ label: 'Alloy USA', total: 14, ourProducts: 245, perProductOnly: true },
		{ label: 'Empty', total: 0, ourProducts: 3, perProductOnly: true },
		{ label: 'None of ours', total: 50, ourProducts: 0, perProductOnly: true },
	], { pageSize: 100, brandCrawlMaxItems: 10000 });
	assert.deepStrictEqual(plan.map((p) => [p.label, p.mode, p.requests]), [
		['Fuel', 'per-product', 75],
		['Alloy USA', 'per-product', 245],
		['Empty', 'per-product', 3],
		['None of ours', 'skip', 0],
	]);
});
