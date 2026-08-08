const axios = require('axios');

async function ensureUsWebsiteAssignmentForSkus({
  skus,
  websiteId,
  magentoConfig,
  concurrency = 20,
  abortOnRedirectFailures = 5,
  abortOnAccessDeniedFailures = 5,
}) {
  const website = Number(websiteId);
  if (!Number.isInteger(website) || website < 1) {
    throw new Error('Invalid websiteId for website assignment');
  }

  if (!magentoConfig?.token) {
    throw new Error('Magento token is required for website assignment');
  }

  const uniqueSkus = Array.from(new Set((skus || []).map((sku) => String(sku || '').trim()).filter(Boolean)));
  const total = uniqueSkus.length;

  if (total === 0) {
    return {
      total,
      assigned: 0,
      alreadyAssigned: 0,
      missingInMagento: 0,
      failed: 0,
      aborted: false,
      abortReason: null,
      failedSamples: [],
    };
  }

  const headers = {
    Authorization: `Bearer ${magentoConfig.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'JustJeepsAPI/price-update',
  };

  let assigned = 0;
  let alreadyAssigned = 0;
  let missingInMagento = 0;
  let failed = 0;
  let redirectFailures = 0;
  let accessDeniedFailures = 0;
  let abortReason = null;
  const failedSamples = [];

  let cursor = 0;

  function isMissingProductError(error) {
    const status = error.response?.status;
    const message = String(error.response?.data?.message || error.message || '').toLowerCase();

    return status === 404 || message.includes("product doesn't exist") || message.includes('no such entity');
  }

  function isAccessDeniedError(error) {
    const status = error.response?.status;
    const details = String(error.response?.data || error.message || '').toLowerCase();

    return status === 403 || details.includes('sucuri website firewall') || details.includes('access denied');
  }

  async function worker() {
    while (cursor < total && !abortReason) {
      const index = cursor++;
      const sku = uniqueSkus[index];
      const encodedSku = encodeURIComponent(sku);

      try {
        await axios.post(
          `${magentoConfig.baseURL}/products/${encodedSku}/websites`,
          {
            productWebsiteLink: {
              sku,
              website_id: website,
            },
          },
          { headers, timeout: magentoConfig.timeout, maxRedirects: 5 }
        );

        assigned++;
      } catch (error) {
        const status = error.response?.status;

        if (isMissingProductError(error)) {
          missingInMagento++;
          continue;
        }

        if ([301, 302, 307, 308].includes(status)) {
          redirectFailures++;
          if (abortOnRedirectFailures > 0 && redirectFailures >= abortOnRedirectFailures) {
            abortReason = `Aborted website assignment after ${redirectFailures} redirect responses. Check MAGENTO_BASE_URL/M2_BASE_URL_DEFAULT/M2_DEFAULT_BASE_URL and Magento routing.`;
          }
        }

        if (isAccessDeniedError(error)) {
          accessDeniedFailures++;
          if (abortOnAccessDeniedFailures > 0 && accessDeniedFailures >= abortOnAccessDeniedFailures) {
            abortReason = `Aborted website assignment after ${accessDeniedFailures} access-denied responses from Magento/Sucuri. Retry later with lower concurrency or skip website assignment for price-only updates.`;
          }
        }

        failed++;
        if (failedSamples.length < 20) {
          failedSamples.push({
            sku,
            status: status || 'ERR',
            details: String(error.response?.headers?.location || error.response?.data?.message || error.message).slice(0, 160),
          });
        }
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), 50, total);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return {
    total,
    assigned,
    alreadyAssigned,
    missingInMagento,
    failed,
    accessDeniedFailures,
    aborted: Boolean(abortReason),
    abortReason,
    failedSamples,
  };
}

module.exports = {
  ensureUsWebsiteAssignmentForSkus,
};
