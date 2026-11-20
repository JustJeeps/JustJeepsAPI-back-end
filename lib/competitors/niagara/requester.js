// Moved to lib/competitors/shopify/requester.js (DD-022). This path keeps the
// Niagara imports working, bound to the Niagara profile.
const shared = require('../shopify/requester');
const { NIAGARA_PROFILE } = require('./profile');

const createRequester = (options) => shared.createRequester({ profile: NIAGARA_PROFILE, ...options });

module.exports = { createRequester };
