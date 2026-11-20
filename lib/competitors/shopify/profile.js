// A Shopify competitor store profile (DD-022): everything that differs from
// one Shopify competitor to the next (feed key, error-code prefix, log tag,
// competitor row, vendors_prefix fields, purity rule), so the collector, the
// snapshot checks, the ingest and the runner are written once and shared.
// Pure.

const { purityRule } = require('./purity');

function required(value, name) {
	if (!value) throw new Error(`store profile needs ${name}`);
	return value;
}

function defineStoreProfile(spec) {
	const key = required(spec.key, 'a key');
	const errorPrefix = required(spec.errorPrefix, 'an errorPrefix');
	const competitor = required(spec.competitor, 'a competitor');
	const mapping = required(spec.mapping, 'a mapping');
	const purity = spec.purity || 'vendor';
	purityRule(purity); // throws on an unknown rule, at definition time
	return Object.freeze({
		key,
		errorPrefix,
		command: spec.command || `seed-${key}`,
		shortName: required(spec.shortName, 'a shortName'),
		competitor: Object.freeze({ ...competitor }),
		mapping: Object.freeze({ handleField: required(mapping.handleField, 'mapping.handleField'), prefixesField: required(mapping.prefixesField, 'mapping.prefixesField') }),
		maxIndexPages: spec.maxIndexPages || 20,
		purity,
			brandPagePath: spec.brandPagePath || null,
		tag: `[${key}]`,
		code: (name) => `${errorPrefix}_${name}`,
	});
}

module.exports = { defineStoreProfile };
