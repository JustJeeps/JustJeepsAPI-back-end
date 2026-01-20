const axios = require('axios');

async function fetchOmixInventory() {
  try {
    const config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: `https://www.parsehub.com/api/v2/projects/t0nQEuradpUT/last_ready_run/data?api_key=t0UjHTnrieK_&format=json`,
      headers: {}
    };

    const response = await axios.request(config);
    return response.data;
  } catch (error) {
    console.error('Error fetching data from Omix API:', error);
    throw error;
  }
}

module.exports = fetchOmixInventory;
