// Moved to lib/competitors/shopify/snapshot.js (DD-022). This path keeps the
// Niagara imports working, bound to the Niagara profile.
const { createSnapshot } = require('../shopify/snapshot');
const { NIAGARA_PROFILE } = require('./profile');

module.exports = createSnapshot(NIAGARA_PROFILE);
