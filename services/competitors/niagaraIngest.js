// Niagara Jeeps payload (DD-021) -> CompetitorProduct, through the shared
// Shopify ingest (services/competitors/shopifyIngest.js, DD-022) bound to the
// Niagara profile. Same exports as before the code was shared.

const { createShopifyIngest, CompetitorIngestError, STALE_COUNT_SQL } = require('./shopifyIngest');
const { NIAGARA_PROFILE } = require('../../lib/competitors/niagara/profile');

module.exports = { ingestNiagara: createShopifyIngest(NIAGARA_PROFILE), NiagaraIngestError: CompetitorIngestError, STALE_COUNT_SQL };
