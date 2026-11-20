// Moved to lib/competitors/shopify/shopifyClient.js (DD-022). This path keeps
// the Niagara imports working, bound to the Niagara profile.
const shared = require('../shopify/shopifyClient');
const { NIAGARA_PROFILE } = require('./profile');

const createShopifyClient = (options) => shared.createShopifyClient({ profile: NIAGARA_PROFILE, ...options });

module.exports = { createShopifyClient, makeError: shared.makeError };
