const axios = require('axios');

async function fetchlowridersInventory() {
  try {
    const config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: `https://www.parsehub.com/api/v2/projects/tK9JxW6-U6Yy/last_ready_run/data?api_key=t0UjHTnrieK_&format=json`,
      headers: {}
    };

const response = await axios.request(config);

    const rawData = response.data;

    if (!Array.isArray(rawData.sku)) {
      throw new Error('Unexpected response format: sku array not found');
    }

    const cleaned = rawData.sku.map(item => ({
      ...item,
      name: item.name?.replace(/^PART #:\s*/, '') || item.name
    }));

    console.log('✅ Cleaned Lowriders Inventory Sample:', cleaned.slice(0, 3));

    return cleaned;

  } catch (error) {
    console.error('❌ Error fetching data from lowriders API:', error);
    throw error;
  }
}

fetchlowridersInventory();

module.exports = fetchlowridersInventory;