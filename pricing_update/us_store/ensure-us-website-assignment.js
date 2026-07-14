const axios = require('axios');

async function ensureUsWebsiteAssignmentForSkus({
  skus,
  websiteId,
  magentoConfig,
  concurrency = 20,
  abortOnRedirectFailures = 5,
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
  };

  let assigned = 0;
  let alreadyAssigned = 0;
  let missingInMagento = 0;
  let failed = 0;
  let redirectFailures = 0;
  let abortReason = null;
  const failedSamples = [];

  let cursor = 0;

  async function worker() {
    while (cursor < total && !abortReason) {
      const index = cursor++;
      const sku = uniqueSkus[index];
      const encodedSku = encodeURIComponent(sku);

      try {
        const productResponse = await axios.get(
          `${magentoConfig.baseURL}/products/${encodedSku}?fields=sku,extension_attributes[website_ids]`,
          { headers, timeout: magentoConfig.timeout, maxRedirects: 5 }
        );

        const websiteIds = productResponse.data?.extension_attributes?.website_ids || [];
        if (Array.isArray(websiteIds) && websiteIds.includes(website)) {
          alreadyAssigned++;
          continue;
        }

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

        if (status === 404) {
          missingInMagento++;
          continue;
        }

        if ([301, 302, 307, 308].includes(status)) {
          redirectFailures++;
          if (abortOnRedirectFailures > 0 && redirectFailures >= abortOnRedirectFailures) {
            abortReason = `Aborted website assignment after ${redirectFailures} redirect responses. Check MAGENTO_BASE_URL/M2_BASE_URL_DEFAULT/M2_DEFAULT_BASE_URL and Magento routing.`;
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
    aborted: Boolean(abortReason),
    abortReason,
    failedSamples,
  };
}

module.exports = {
  ensureUsWebsiteAssignmentForSkus,
};
