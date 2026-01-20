const axios = require('axios');

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function getProductsFromPages() {
  const results = [];
  const baseUrl = 'https://www.justjeeps.com/rest/V1/products';
  const token = `Bearer ${process.env.MAGENTO_KEY}`;

  // ✅ Use canonical param names + smaller pageSize (big pages are flaky)
  const PAGE_SIZE = Number(process.env.PAGE_SIZE || 5000);
  const MAX_PAGES = Number(process.env.MAX_PAGES || 19);

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `${baseUrl}?fields=items[sku,created_at,status,name,price,weight,media_gallery_entries[file],` +
        `custom_attributes[searchable_sku,url_path,url_key,length,width,height,shipping_freight,part,thumbnail,black_friday_sale_attribute]]` +
        `&searchCriteria[pageSize]=${PAGE_SIZE}&searchCriteria[currentPage]=${page}`;

      console.log(`→ Fetching page ${page}/${MAX_PAGES} (pageSize=${PAGE_SIZE})`);
      const started = Date.now();

      let response;
      try {
        response = await axios.get(url, {
          headers: {
            Authorization: token,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          timeout: 60000,
          maxBodyLength: Infinity,
        });
      } catch (e) {
        // 🔎 Network/HTTP error diagnostics
        console.error(
          `✖ Page ${page} request failed: status=${e.response?.status || 'no-status'} code=${e.code || 'no-code'} ` +
          `time=${Date.now() - started}ms`
        );
        if (e.response?.data) {
          console.error(`Body(head): ${JSON.stringify(e.response.data).slice(0, 800)}`);
        }
        // Don’t crash—just stop or continue; choose one:
        break; // or: continue;
      }

      // 🔎 Response shape diagnostics
      const status = response?.status;
      const data = response?.data;
      const items = data?.items;
      console.log(
        `✔ Page ${page} status=${status} time=${Date.now() - started}ms; ` +
        `itemsType=${Array.isArray(items) ? 'array' : typeof items}; ` +
        (Array.isArray(items) ? `itemsLen=${items.length}` : `bodyHead=${JSON.stringify(data).slice(0, 300)}`)
      );

      // ✅ Guard: only spread if it's really an array
      if (!Array.isArray(items)) {
        console.warn(`⚠ Page ${page} returned no items array. Stopping early to avoid crash.`);
        break;
      }

      results.push(...items);

      // Optional early-stop heuristic: if this page returned < pageSize, next page likely empty
      if (items.length < PAGE_SIZE) {
        console.log(`ℹ Page ${page} had ${items.length} < ${PAGE_SIZE}. Assuming last page.`);
        break;
      }

      await sleep(400); // small pause
    }

    console.log(`✅ Total collected items: ${results.length}`);
    return results;
  } catch (error) {
    // 🔎 Final catch diagnostics
    console.error('Unhandled error:', error.message);
    if (error.response) {
      console.error(`status=${error.response.status}`);
      console.error(`bodyHead=${JSON.stringify(error.response.data).slice(0, 800)}`);
    }
  }
}

module.exports = getProductsFromPages;


// const axios = require('axios');

// async function getProductsFromPages() {
//   const results = [];
//   const baseUrl = 'https://www.justjeeps.com/rest/V1/products';
//   const token = `Bearer ${process.env.MAGENTO_KEY}`;

//   try {
//     // Loop through 9 pages
//     for (let page = 1; page <= 12; page++) {//20
//       const config = {
//         method: 'get',
//         maxBodyLength: Infinity,
//         url: `${baseUrl}?fields=items[sku,status,name,price,weight,media_gallery_entries[file],custom_attributes[searchable_sku,url_path,url_key,length,width,height,shipping_freight,part,thumbnail]]&searchCriteria[PageSize]=5000&searchCriteria[CurrentPage]=${page}`,
//         headers: { 
//           'Authorization': token, 
//           'Content-Type': 'application/json', 
//           'Accept': 'application/json', 
//           'Cookie': 'PHPSESSID=nnhu3rl2qk69t18auce339csa1'
//         },
//       };
//       const response = await axios.request(config);
//       results.push(...response.data.items); // Concatenate items into results array
//       // Introduce a delay of 1 second between each request
//       await new Promise(resolve => setTimeout(resolve, 1000));
//     }

//     console.log(JSON.stringify(results));
//     return results;
//   } catch (error) {
//     console.log(error);
//   }
// }


// // getProductsFromPages();

// module.exports = getProductsFromPages;