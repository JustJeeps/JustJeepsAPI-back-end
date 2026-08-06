// Consolidates the ~7 copies of runWithRetry and 2 of runWithConcurrency
// spread across the seeders. New pipelines import from here; legacy seeders
// migrate opportunistically.

async function withRetry(fn, label = "op", { maxRetries = 5, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const wait = baseDelayMs * attempt * attempt;
      console.warn(`⚠️ ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${wait}ms: ${err.message}`);
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
