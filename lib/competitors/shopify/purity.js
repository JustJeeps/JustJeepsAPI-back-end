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
// code at all is dropped and counted (uncoded). The brand is impure when the
// foreign share of coded items passes 25%, or when nothing is its own, which
// catches a wrong handle or a missing prefix instead of writing nothing quietly.
function skuCodePurity(items, vendorLabels, brand) {
	const prefixes = (brand && brand.skuPrefixes) || [];
	const isOwn = (item) => prefixes.some((p) => item.competitorSku.startsWith(p));
	const own = items.filter(isOwn);
	const others = items.filter((item) => !isOwn(item));
	const foreign = others.filter((item) => codeOf(item.competitorSku)).length;
	const uncoded = others.length - foreign;
	const coded = own.filter((item) => codeOf(item.competitorSku)).length + foreign;
	const impure = items.length > 0 && (own.length === 0 || (coded > 0 && foreign / coded > MAX_FOREIGN_SHARE));
	return { kept: impure ? [] : own, foreign, impure, stats: { dominantVendor: dominantVendor(vendorLabels).vendor, uncoded } };
}

const RULES = Object.freeze({ vendor: vendorPurity, 'sku-code': skuCodePurity });

function purityRule(name) {
	const rule = RULES[name];
	if (!rule) throw new Error(`unknown purity rule ${name}`);
	return rule;
}

module.exports = { vendorPurity, skuCodePurity, purityRule, MAX_FOREIGN_SHARE };
