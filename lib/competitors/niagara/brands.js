// Moved to lib/competitors/shopify/brands.js (DD-022). This path keeps the
// Niagara imports working, bound to the Niagara profile (niagara_code and
// niagara_sku_prefixes in vendors_prefix.js).
const { createBrandReader } = require('../shopify/brands');
const { NIAGARA_PROFILE } = require('./profile');

const { readBrands, filterBrands } = createBrandReader(NIAGARA_PROFILE);

module.exports = { niagaraBrands: readBrands, filterBrands };
