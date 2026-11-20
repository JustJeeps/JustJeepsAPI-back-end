// Brand purity rules for a Shopify brand collection (DD-021, DD-022). A brand
// collection can hold other brands' products; the rule decides which items
// are the brand's own, and drops the whole brand (impure, counted as failed)
// when the foreign share passes 25%, because the handle may then point at a
// category. Rules share one contract so the store profile picks one:
//   (items, vendorLabels, brand) => { kept, foreign, impure, stats }
// Pure.

const { dominantVendor } = require('./brandMap');

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

const RULES = Object.freeze({ vendor: vendorPurity });

function purityRule(name) {
	const rule = RULES[name];
	if (!rule) throw new Error(`unknown purity rule ${name}`);
	return rule;
}

module.exports = { vendorPurity, purityRule, MAX_FOREIGN_SHARE };
