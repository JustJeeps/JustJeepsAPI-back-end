// The Niagara Jeeps store profile (DD-021, DD-022). Its codes, tag, fields and
// purity rule are the ones the Niagara run had before the code was shared, so
// production behaviour does not change. Pure.

const { defineStoreProfile } = require('../shopify/profile');
const { COMPETITOR } = require('../../../config/niagara');

const NIAGARA_PROFILE = defineStoreProfile({
	key: 'niagara',
	errorPrefix: 'NIAGARA',
	shortName: 'Niagara',
	competitor: COMPETITOR,
	mapping: { handleField: 'niagara_code', prefixesField: 'niagara_sku_prefixes' },
	maxIndexPages: 20,
	purity: 'vendor',
	brandPagePath: '/pages/shop-by-brand',
});

module.exports = { NIAGARA_PROFILE };
