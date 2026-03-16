const axios = require('axios');

async function ensureUsWebsiteAssignmentForSkus({
  skus,
  websiteId,
  magentoConfig,
  concurrency = 20,
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
  const failedSamples = [];

  let cursor = 0;

  async function worker() {
    while (cursor < total) {
      const index = cursor++;
      const sku = uniqueSkus[index];
      const encodedSku = encodeURIComponent(sku);

      try {
        const productResponse = await axios.get(
          `${magentoConfig.baseURL}/products/${encodedSku}?fields=sku,extension_attributes[website_ids]`,
          { headers, timeout: magentoConfig.timeout }
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
          { headers, timeout: magentoConfig.timeout }
        );

        assigned++;
      } catch (error) {
        const status = error.response?.status;

        if (status === 404) {
          missingInMagento++;
          continue;
        }

        failed++;
        if (failedSamples.length < 20) {
          failedSamples.push({
            sku,
            status: status || 'ERR',
            details: String(error.response?.data?.message || error.message).slice(0, 160),
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
    failedSamples,
  };
}

module.exports = {
  ensureUsWebsiteAssignmentForSkus,
};
