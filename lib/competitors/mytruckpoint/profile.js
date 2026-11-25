// The MyTruckPoint store profile (DD-022). mytruckpoint.ca is a Shopify store
// like Niagara Jeeps, with three differences measured on 2026-11-19: the
// vendor text varies inside one brand, so purity is judged by the SKU code
// (<4 letters>_<part number>); the same SKU is often listed twice, so the
// purchasable copy wins; and the store is large (22 index pages, about 200k
// listings), so the index may run to 40 pages and snapshots are gzipped.
// It has no server-side brand page. Pure.

const { defineStoreProfile } = require('../shopify/profile');
const { COMPETITOR } = require('../../../config/mytruckpoint');

const MYTRUCKPOINT_PROFILE = defineStoreProfile({
	key: 'mytruckpoint',
	errorPrefix: 'MYTRUCKPOINT',
	shortName: 'MyTruckPoint',
	competitor: COMPETITOR,
	mapping: { handleField: 'mytruckpoint_code', prefixesField: 'mytruckpoint_sku_prefixes' },
	maxIndexPages: 40,
	purity: 'sku-code',
	preferAvailable: true,
	gzipSnapshots: true,
});

module.exports = { MYTRUCKPOINT_PROFILE };
