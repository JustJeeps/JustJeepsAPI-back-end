// Brand purity rules for a Shopify brand collection (DD-021, DD-022). A brand
// collection can hold other brands' products; the rule decides which items
// are the brand's own, and drops the whole brand (impure, counted as failed)
// when the foreign share passes 25%, because the handle may then point at a
// category. Rules share one contract so the store profile picks one:
//   (items, vendorLabels, brand) => { kept, foreign, impure, stats }
// Pure.

const { dominantVendor } = require('./brandMap');
const { codeOf } = require('./skuCode');

const MAX_FOREIGN_SHARE = 0.25;
// SKUs without a code kept in the brand stats, so a second listing scheme
// (misMMICP-... for Mishimoto) shows up in the snapshot and can be mapped.
const UNCODED_SAMPLE = 5;

// Niagara (DD-021): the most common vendor text of the collection is the
// brand, compared case-insensitively.
function vendorPurity(items, vendorLabels) {
	const { vendor } = dominantVendor(vendorLabels);
	const own = items.filter((i) => i.vendor.toUpperCase() === vendor);
	const foreign = items.length - own.length;
	const impure = items.length > 0 && foreign / items.length > MAX_FOREIGN_SHARE;
	return { kept: impure ? [] : own, foreign, impure, stats: { dominantVendor: vendor } };
}

// MyTruckPoint (DD-022): the vendor text varies inside one brand (aFe, AFE,
// aFe Power; WARN IND. and Warn), so it cannot tell brands apart. The SKU code
// can: an item is the brand's own when its SKU starts with one of the brand's
// measured prefixes (mytruckpoint_sku_prefixes). Another code is foreign; no
// code at all is dropped and counted (uncoded), unless the brand maps that
// scheme too: some brands are also listed as <their letters><part number>
// (MIS for Mishimoto, D18 for Dorman), and that text is one more prefix.
// The brand is impure when the foreign share of coded items passes 25%, or
// when nothing is its own, which catches a wrong handle or a missing prefix
// instead of writing nothing quietly.
function skuCodePurity(items, vendorLabels, brand) {
	const prefixes = (brand && brand.skuPrefixes) || [];
	// A coded SKU is the brand's own only when its exact code is mapped, so a
	// second-scheme prefix (REA) never claims another brand's code (REAL_).
	const isOwn = (item) => {
		const code = codeOf(item.competitorSku);
		return code ? prefixes.includes(code) : prefixes.some((p) => item.competitorSku.startsWith(p));
	};
	const own = items.filter(isOwn);
	const others = items.filter((item) => !isOwn(item));
	const foreign = others.filter((item) => codeOf(item.competitorSku)).length;
	const uncodedItems = others.filter((item) => !codeOf(item.competitorSku));
	const uncoded = uncodedItems.length;
	const coded = own.filter((item) => codeOf(item.competitorSku)).length + foreign;
	const impure = items.length > 0 && (own.length === 0 || (coded > 0 && foreign / coded > MAX_FOREIGN_SHARE));
	return { kept: impure ? [] : own, foreign, impure, stats: { dominantVendor: dominantVendor(vendorLabels).vendor, uncoded, uncodedSample: uncodedItems.slice(0, UNCODED_SAMPLE).map((i) => i.competitorSku) } };
}

const RULES = Object.freeze({ vendor: vendorPurity, 'sku-code': skuCodePurity });

function purityRule(name) {
	const rule = RULES[name];
	if (!rule) throw new Error(`unknown purity rule ${name}`);
	return rule;
}

module.exports = { vendorPurity, skuCodePurity, purityRule, MAX_FOREIGN_SHARE };
