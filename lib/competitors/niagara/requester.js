// Pacing and retries for niagarajeeps.ca (DD-021). One request at a time with
// a fixed delay plus jitter between attempts. Retryable errors (network, 5xx,
// 429) are retried with quadratic backoff, or after Retry-After for a 429
// (capped). A Cloudflare challenge gets one slow retry and then fails loud: we
// never try to solve it. sleep and random are injected so tests run instantly.

function createRequester({
	sleep, random = Math.random, delayMs, jitterMs, maxAttempts = 3, backoffMs = 2000,
	retryAfterCapMs = 120000, challengeRetryDelayMs = 60000, logger,
}) {
	const stats = { requests: 0, httpAttempts: 0, retries: 0, rateLimited: 0, challenged: 0 };
	let sent = false;

	async function pace() {
		if (sent) await sleep(delayMs + Math.floor(random() * jitterMs));
		sent = true;
	}

	function retryWait(error, attempt) {
		if (error.code === 'NIAGARA_RATE_LIMITED' && Number.isFinite(error.retryAfterMs)) return Math.min(error.retryAfterMs, retryAfterCapMs);
		return backoffMs * attempt * attempt;
	}

	async function run(label, fn) {
		stats.requests += 1;
		let challengeRetried = false;
		for (let attempt = 1; ; attempt += 1) {
			await pace();
			stats.httpAttempts += 1;
			try {
				return await fn();
			} catch (error) {
				if (error.code === 'NIAGARA_RATE_LIMITED') stats.rateLimited += 1;
				if (error.code === 'NIAGARA_CHALLENGED') {
					stats.challenged += 1;
					if (challengeRetried) throw error;
					challengeRetried = true;
					logger.warn(`[niagara] ${label}: challenge page, waiting ${challengeRetryDelayMs}ms before one retry`);
					await sleep(challengeRetryDelayMs);
					continue;
				}
				if (!error.retryable || attempt >= maxAttempts) throw error;
				const wait = retryWait(error, attempt);
				stats.retries += 1;
				logger.warn(`[niagara] ${label}: ${error.code} (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms`);
				await sleep(wait);
			}
		}
	}

	return { run, stats: () => ({ ...stats }) };
}

module.exports = { createRequester };
