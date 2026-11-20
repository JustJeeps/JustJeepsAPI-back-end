// Moved to lib/competitors/shopify/collect.js (DD-022). This path keeps the
// Niagara imports working, bound to the Niagara profile.
const { createCollector, CompetitorCollectError, SCHEMA_VERSION } = require('../shopify/collect');
const { NIAGARA_PROFILE } = require('./profile');

module.exports = { collectNiagara: createCollector(NIAGARA_PROFILE), NiagaraCollectError: CompetitorCollectError, SCHEMA_VERSION };
