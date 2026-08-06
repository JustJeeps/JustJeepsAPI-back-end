// Linhas de frescor dos feeds para o Cron Activity Digest diario. Devolve
// resultados no MESMO shape das linhas de buildCronDigestResults (server.js)
// — { cmd, success, durationMs, logFile, error } — para concatenar direto no
// e-mail: feed stale ou sem lote vira uma linha de falha e o assunto do
// digest acusa, em vez do silencio de hoje.
//
// Prisma injetado como primeiro parametro (padrao lib/reports/requestsDigest.js).

const catalog = require('./catalog');

async function collectFeedFreshnessResults(prisma, feedDefinitions, { now = new Date() } = {}) {
	const statuses = await catalog.listFeedStatuses(prisma, feedDefinitions, { now });

	return statuses.map((status) => {
		let error = null;
		if (!status.currentBatch) {
			error = `feed "${status.feed}" has no catalogued artifact batch`;
		} else if (status.stale) {
			error = `feed "${status.feed}" artifacts are ${status.ageHours.toFixed(1)}h old (threshold ${status.staleAfterHours}h)`;
		}

		return {
			cmd: `feed:${status.feed}`,
			success: !error,
			durationMs: null,
			logFile: null,
			error,
		};
	});
}

module.exports = { collectFeedFreshnessResults };
