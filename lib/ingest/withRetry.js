// Consolida as ~7 copias de runWithRetry e 2 de runWithConcurrency espalhadas
// pelos seeders. Novos pipelines importam daqui; seeders legados migram
// oportunisticamente.

async function withRetry(fn, label = "op", { maxRetries = 5, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const wait = baseDelayMs * attempt * attempt;
      console.warn(`⚠️ ${label} falhou (tentativa ${attempt}/${maxRetries}) — retry em ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function withConcurrency(items, limit, iterator) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await iterator(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { withRetry, withConcurrency };
