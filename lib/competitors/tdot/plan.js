// Request plan per TDOT label (DD-019 section 4, "hybrid"). A brand word is a
// wildcard text search on Klevu, so some labels are huge (Covercraft 92k
// items). Per label we pick the cheaper shape: crawl the label's pages, or
// query once per product of ours that carries the label. A label found only
// through one of our products (perProductOnly) is always queried per product. Pure.

function planLabels(labels, { pageSize = 100, brandCrawlMaxItems = 10000, maxRequests = Infinity } = {}) {
	const plan = (labels || []).map((entry) => {
		const total = Number(entry.total) || 0;
		const ourProducts = Number(entry.ourProducts) || 0;
		const pages = Math.ceil(total / pageSize);
		if (ourProducts <= 0) return { label: entry.label, mode: 'skip', requests: 0, total, ourProducts };
		// The label search does not show the brand, but our own products do.
		if (entry.perProductOnly) return { label: entry.label, mode: 'per-product', requests: ourProducts, total, ourProducts };
		if (total <= 0) return { label: entry.label, mode: 'skip', requests: 0, total, ourProducts };
		const crawl = total <= brandCrawlMaxItems && pages <= ourProducts;
		return { label: entry.label, mode: crawl ? 'crawl' : 'per-product', requests: crawl ? pages : ourProducts, total, ourProducts };
	});

	// Budget: keep the cheap labels, mark the most expensive ones over-budget
	// first, so a tight cap still covers as many labels as possible.
	let budget = maxRequests;
	const byCost = plan.filter((p) => p.mode !== 'skip').sort((a, b) => a.requests - b.requests);
	for (const entry of byCost) {
		if (entry.requests <= budget) budget -= entry.requests;
		else entry.mode = 'over-budget';
	}
	return plan;
}

module.exports = { planLabels };
