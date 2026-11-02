// Niagara Jeeps payload (DD-021) -> CompetitorProduct. Prisma is injected so
// the tests run with a stub. Matching is per brand (lib/competitors/niagara/
// match.js), the write is the shared competitor upsert, and stale rows are
// only counted and reported: this job never deletes or hides anything.

const { COMPETITOR } = require('../../config/niagara');
const { buildIndexes, matchItems } = require('../../lib/competitors/niagara/match');
const { checkMatch } = require('../../lib/competitors/niagara/canaries');
const { resolveCompetitor, upsertCompetitorRows } = require('../../lib/competitors/competitorUpsert');

const UNMATCHED_LOG_SAMPLE = 25;
const AMBIGUOUS_LOG_LIMIT = 50;

// Rows of this competitor that the run did not see. Counted, never deleted.
const STALE_COUNT_SQL = `
  SELECT count(*)::int AS stale FROM "CompetitorProduct" cp
  WHERE cp.competitor_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text($2::jsonb) s(sku)
      WHERE s.sku = cp.competitor_sku
    );
`;

class NiagaraIngestError extends Error {
	constructor(code, message, failures = []) {
		super(`${code}: ${message}`);
		this.code = code;
		this.failures = failures;
	}
}

function loadProducts(prisma, prefixes) {
	return prisma.product.findMany({
		where: {
			jj_prefix: { in: prefixes },
			searchable_sku: { not: null },
			NOT: [{ searchable_sku: '' }, { searchable_sku: { endsWith: '-' } }],
		},
		select: { sku: true, searchable_sku: true, status: true, jj_prefix: true },
	});
}

async function countStale(prisma, competitorId, rows) {
	const result = await prisma.$queryRawUnsafe(STALE_COUNT_SQL, competitorId, JSON.stringify(rows.map((r) => r.competitor_sku)));
	return Number(result && result[0] && result[0].stale) || 0;
}

function logMatch(logger, result) {
	logger.info(`[niagara] step=match matched=${result.rows.length} unmatched=${result.unmatched.length} ambiguous=${result.ambiguous.length} collisions=${result.collisions.length}`);
	if (result.unmatched.length) logger.info(`[niagara] unmatched sample: ${result.unmatched.slice(0, UNMATCHED_LOG_SAMPLE).map((u) => u.competitorSku).join(', ')}`);
	for (const a of result.ambiguous.slice(0, AMBIGUOUS_LOG_LIMIT)) logger.warn(`[niagara] ambiguous ${a.competitorSku} -> ${a.chosen} (candidates: ${a.candidates.join(', ')})`);
}

// baselineRows: rows written by the last successful full run, or null.
async function ingestNiagara({ prisma, payload, brands, thresholds, logger, dryRun = false, baselineRows = null }) {
	const sample = Boolean(payload.sample);
	const competitor = await resolveCompetitor(prisma, COMPETITOR, dryRun);
	const prefixes = [...new Set(payload.items.map((i) => i.jjPrefix))];
	const products = prefixes.length ? await loadProducts(prisma, prefixes) : [];
	const result = matchItems(payload.items, { indexes: buildIndexes(products), brands });
	logMatch(logger, result);

	const matched = result.rows.length;
	const verdict = checkMatch({ matched, baselineRows }, thresholds, { sample });
	if (!verdict.ok) throw new NiagaraIngestError('NIAGARA_MATCH_GUARD', verdict.failures.map((f) => f.message).join('; '), verdict.failures);

	const counts = {
		inserted: 0, updated: 0, unchanged: 0, deleted: 0,
		skipped: result.unmatched.length + result.collisions.length + (payload.collection?.invalidCount || 0),
		markedStale: sample || !competitor ? null : await countStale(prisma, competitor.id, result.rows),
	};
	const summary = {
		competitorId: competitor ? competitor.id : null, matched, matchRate: payload.items.length ? matched / payload.items.length : 0,
		counts, byBrand: result.byBrand, dryRun, sample,
		report: { unmatched: result.unmatched, ambiguous: result.ambiguous, collisions: result.collisions },
	};
	if (counts.markedStale) logger.warn(`[niagara] step=stale ${counts.markedStale} rows of ${COMPETITOR.name} were not seen in this run: kept, not deleted`);
	if (dryRun) {
		logger.info('[niagara] dry-run: no writes');
		return summary;
	}

	const written = await upsertCompetitorRows({ prisma, competitorId: competitor.id, rows: result.rows });
	const finalCounts = { ...counts, ...written, unchanged: Math.max(0, matched - written.inserted - written.updated) };
	logger.info(`[niagara] step=upsert inserted=${finalCounts.inserted} updated=${finalCounts.updated} unchanged=${finalCounts.unchanged}`);
	return { ...summary, counts: finalCounts };
}

module.exports = { ingestNiagara, NiagaraIngestError, STALE_COUNT_SQL };
