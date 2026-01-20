const axios = require('axios');

async function NorthrigeData() {
  try {
    const config = {
      method: 'get',
      maxBodyLength: Infinity,
      // url: `https://www.parsehub.com/api/v2/projects/${process.env.PARSEHUB_KEY_NORTHRIDGE}/last_ready_run/data?api_key=t0UjHTnrieK_&format=json`,
      url: `https://www.parsehub.com/api/v2/projects/tXLcYOFE6taM/last_ready_run/data?api_key=t0UjHTnrieK_&format=json`,
      headers: {}
    };

    const response = await axios.request(config);
    // console.log(JSON.stringify(response.data[0]));
    // console.log("response.data from Northridge", response.data);
    return response.data;
  } catch (error) {
    console.log('Error from Northridge API',error);
  }
}

// NorthrigeData();
module.exports = NorthrigeData;
