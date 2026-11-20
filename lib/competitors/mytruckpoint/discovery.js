// Read-only brand discovery rules for MyTruckPoint (DD-022). The store has no
// server-side brand index, so brands are found among its 5,000+ collections by
// name, then each candidate's first products page is measured. A SKU code is
// per brand and per distributor: most brands carry one (BBGL_ for Bilstein),
// some carry two or more under the same vendor name (Camco BBJF_ and CFTT_).
// A category mixes vendor names. Only exact names whose codes all carry one
// vendor name are proposed for vendors_prefix.js as is; everything else goes
// to the team review sheet. Pure.

const { compact, GENERIC_WORDS } = require('../shopify/brandMap');
const { codeOf } = require('../shopify/skuCode');
const { dominantVendor } = require('../shopify/brandMap');

const LISTING_CAP = 25000;
const MIN_VENDOR_SHARE = 0.5;
const MIN_PREFIX_SHARE = 0.02;
const MIN_CODED_SHARE = 0.5;
const MIN_SHORT_TITLE = 4;
const SAMPLE_SIZE = 5;

const words = (text) => String(text ?? '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
const startsWithWords = (long, short) => short.length > 0 && short.length < long.length && short.every((w, i) => long[i] === w);

// A title made only of words that never tell brands apart ("Performance",
// "Suspension", "Wheels") is a category and never matches loosely.
const isGenericTitle = (title) => {
	const all = words(title);
	return all.length > 0 && all.every((w) => GENERIC_WORDS.has(w));
};

// exact: same name. loose: our name opens a longer store title ("Rough
// Country Lift Kits & Suspension Canada"), or a short store title opens our
// name ("Omix" for OMIX-ADA).
function tierOf(brandName, collection) {
	const brand = compact(brandName);
	if (brand && (compact(collection.title) === brand || compact(collection.handle) === brand)) return 'exact';
	if (isGenericTitle(collection.title)) return null;
	const brandWords = words(brandName);
	const titleWords = words(collection.title);
	if (startsWithWords(titleWords, brandWords)) return 'loose';
	if (startsWithWords(brandWords, titleWords) && compact(collection.title).length >= MIN_SHORT_TITLE) return 'loose';
	return null;
}

function nameCandidates(collections, vendorsPrefix) {
	const seen = new Set();
	const out = [];
	for (const row of vendorsPrefix || []) {
		if (!row.jj_prefix || !row.brand_name) continue;
		for (const collection of collections || []) {
			if (!(Number(collection.products_count) > 0)) continue;
			const tier = tierOf(row.brand_name, collection);
			const key = `${row.jj_prefix}|${collection.handle}`;
			if (!tier || seen.has(key)) continue;
			seen.add(key);
			out.push({ jjPrefix: row.jj_prefix, brandName: row.brand_name, handle: collection.handle, title: collection.title, productsCount: Number(collection.products_count), tier });
		}
	}
	return out;
}

const upper = (text) => String(text ?? '').trim().toUpperCase();

function codeList(entries, coded) {
	const byCode = new Map();
	for (const { code, vendor } of entries) byCode.set(code, [...(byCode.get(code) || []), vendor]);
	return [...byCode]
		.map(([code, vendors]) => ({ code, count: vendors.length, share: vendors.length / coded, vendor: dominantVendor(vendors).vendor }))
		.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
}

// codes: every code on the page with its count, share of coded SKUs and the
// vendor name its listings carry; vendor and vendorShare: the most common
// vendor name of the page, compared without case.
function measureSample(products) {
	const entries = (products || []).flatMap((p) => (p.variants || []).map((v) => ({ sku: String(v.sku || '').trim(), vendor: upper(p.vendor) })));
	const coded = entries.filter((e) => codeOf(e.sku)).map((e) => ({ code: codeOf(e.sku), vendor: e.vendor }));
	const { vendor, share } = dominantVendor((products || []).map((p) => p.vendor));
	return {
		codes: codeList(coded, coded.length),
		coded: coded.length,
		codedShare: entries.length ? coded.length / entries.length : 0,
		vendor,
		vendorShare: share,
		products: (products || []).length,
		samples: entries.filter((e) => codeOf(e.sku)).slice(0, SAMPLE_SIZE).map((e) => e.sku),
		uncodedSamples: entries.filter((e) => !codeOf(e.sku)).slice(0, SAMPLE_SIZE).map((e) => e.sku),
	};
}

const percent = (ratio) => `${Math.round(ratio * 100)}%`;

function classify(candidate, m) {
	if (!m.products) return { status: 'rejected', reason: 'empty first page', prefixes: [] };
	if (!m.coded) return { status: 'rejected', reason: 'no SKU carries a code', prefixes: [] };
	if (m.vendorShare < MIN_VENDOR_SHARE) return { status: 'rejected', reason: `top vendor name on ${percent(m.vendorShare)} only: a category, not a brand`, prefixes: [] };
	const kept = m.codes.filter((c) => c.share >= MIN_PREFIX_SHARE);
	const prefixes = kept.map((c) => c.code);
	if (candidate.productsCount > LISTING_CAP) return { status: 'flagged', reason: `over the ${LISTING_CAP} listing cap`, prefixes };
	if (m.codedShare < MIN_CODED_SHARE) return { status: 'review', reason: `only ${percent(m.codedShare)} of SKUs carry a code`, prefixes };
	if (kept.some((c) => c.vendor !== m.vendor)) return { status: 'review', reason: `codes carry different vendor names: ${kept.map((c) => `${c.code} ${c.vendor}`).join(', ')}`, prefixes };
	if (candidate.tier !== 'exact') return { status: 'review', reason: 'name matches loosely', prefixes };
	return { status: 'auto', reason: prefixes.length > 1 ? `exact name, ${prefixes.length} codes under one vendor name` : 'exact name, single code', prefixes };
}

const demote = (decision, reason) => ({ ...decision, status: decision.status === 'auto' ? 'review' : decision.status, reason });

// One code measured on two of our brands, or one brand proposed on two
// collections, cannot be decided by a rule: both go to review. A loose name
// ("egr-and-related-components" for EGR) never outweighs an exact one: it is
// sent to review with the reason, and the exact brand (HELLA) keeps its code.
const rivalsOf = (d, live, code) => live.filter((o) => o.jjPrefix !== d.jjPrefix && o.prefixes.includes(code) && (d.tier !== 'exact' || o.tier === 'exact'));

function decideAll(candidates, measures) {
	const decided = candidates.map((c) => {
		const m = measures[c.handle] || measureSample([]);
		const { codes, codedShare, vendor, vendorShare, samples, uncodedSamples } = m;
		return { ...c, codes, codedShare, vendor, vendorShare, samples, uncodedSamples, ...classify(c, m) };
	});
	const live = decided.filter((d) => d.status !== 'rejected');
	return decided.map((d) => {
		if (d.status === 'rejected') return d;
		const shared = d.prefixes.find((code) => rivalsOf(d, live, code).length);
		if (shared) {
			const owners = [...new Set(rivalsOf(d, live, shared).map((o) => o.jjPrefix))];
			return demote(d, `code ${shared} also measured on ${owners.join(', ')}`);
		}
		const autos = live.filter((o) => o.jjPrefix === d.jjPrefix && o.status === 'auto');
		return autos.length > 1 ? demote(d, 'two collections proposed for one brand') : d;
	});
}

function proposalLines(decisions) {
	return decisions
		.filter((d) => d.status === 'auto')
		.map((d) => `${d.jjPrefix}: mytruckpoint_code: "${d.handle}", mytruckpoint_sku_prefixes: [${d.prefixes.map((p) => `"${p}"`).join(', ')}]`);
}

module.exports = { nameCandidates, measureSample, classify, decideAll, proposalLines, LISTING_CAP };
