
// const axios = require("axios");

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// function isRetryableHttp(err) {
//   const status = err?.response?.status;
//   if (!status) return true; // network / timeout
//   return [408, 425, 429, 500, 502, 503, 504].includes(status);
// }

// /**
//  * Fetch one Meyer item by ItemNumber.
//  * Returns either:
//  *  - array like original: [ { ItemNumber, CustomerPrice, QtyAvailable, PartStatus, Length, Width, Height, Weight, ... } ]
//  *  - or { statusCode, errorMessage } on failure to keep original "skip if data.statusCode" compatibility
//  */
// async function fetchMeyerItem(itemNumber, opts = {}) {
//   const {
//     timeoutMs = Number(process.env.MEYER_TIMEOUT_MS || 30000),
//     maxRetries = Number(process.env.MEYER_RETRY_MAX || 5),
//     baseDelayMs = Number(process.env.MEYER_RETRY_DELAY_MS || 400),
//     minDelayBetweenCallsMs = Number(process.env.MEYER_MIN_DELAY_MS || 0),
//   } = opts;

//   const url = `https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2/ItemInformation?ItemNumber=${encodeURIComponent(
//     itemNumber
//   )}`;

//   // Your original code included a JSON body but method was "get".
//   // We keep GET and headers that matter (Authorization).
//   const config = {
//     method: "get",
//     url,
//     timeout: timeoutMs,
//     headers: {
//       Authorization: `Espresso ${process.env.MEYER_KEY}`,
//       "Content-Type": "application/json",
//     },
//     // If Meyer truly requires username/password in-body, you can re-add data here,
//     // but most APIs ignore body on GET.
//   };

//   for (let attempt = 1; attempt <= maxRetries; attempt++) {
//     try {
//       const res = await axios.request(config);
//       if (minDelayBetweenCallsMs > 0) await sleep(minDelayBetweenCallsMs);
//       return res.data;
//     } catch (err) {
//       const retryable = isRetryableHttp(err);
//       if (!retryable || attempt === maxRetries) {
//         const status = err?.response?.status;
//         const msg =
//           err?.response?.data?.errorMessage ||
//           err?.message ||
//           "Unknown Meyer API error";
//         return {
//           statusCode: status || 500,
//           errorMessage: msg,
//           itemNumber,
//         };
//       }
//       const backoff = baseDelayMs * Math.pow(2, attempt - 1);
//       await sleep(backoff);
//     }
//   }

//   return { statusCode: 500, errorMessage: "Unexpected retry loop exit", itemNumber };
// }

// /**
//  * Concurrency pool runner for many ItemNumbers.
//  * Returns array aligned to input order: each element is response data (array) or {statusCode,...}
//  */
// async function fetchMeyerItems(itemNumbers, opts = {}) {
//   const concurrency = Number(opts.concurrency || process.env.MEYER_CONCURRENCY || 6);

//   let idx = 0;
//   const results = new Array(itemNumbers.length);

//   const worker = async () => {
//     while (true) {
//       const current = idx++;
//       if (current >= itemNumbers.length) return;
//       const item = itemNumbers[current];
//       results[current] = await fetchMeyerItem(item, opts);
//     }
//   };

//   const workers = [];
//   for (let i = 0; i < concurrency; i++) workers.push(worker());
//   await Promise.all(workers);

//   return results;
// }

// module.exports = {
//   fetchMeyerItem,
//   fetchMeyerItems,
// };


const axios = require("axios");
const prisma = require("../../../lib/prisma");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeItemNumber(value) {
  return (value ?? "")
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isBestopMeyerCode(value) {
  return (value ?? "").toString().toUpperCase().startsWith("BES");
}

function bestopDashlessFallback(value) {
  const raw = (value ?? "").toString().toUpperCase().trim();
  if (!raw || !isBestopMeyerCode(raw)) return null;
  const dashless = raw.replace(/-/g, "");
  return dashless !== raw ? dashless : null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isRetryableHttp(err) {
  const status = err?.response?.status;
  if (!status) return true; // network / timeout
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function fetchMeyerBatch(itemNumbers, opts = {}) {
  const {
    timeoutMs = Number(process.env.MEYER_TIMEOUT_MS || 30000),
    maxRetries = Number(process.env.MEYER_RETRY_MAX || 5),
    baseDelayMs = Number(process.env.MEYER_RETRY_DELAY_MS || 400),
    minDelayBetweenCallsMs = Number(process.env.MEYER_MIN_DELAY_MS || 0),
  } = opts;

  const joined = itemNumbers.map((n) => encodeURIComponent(n)).join(",");
  const url = `https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2/ItemInformation?ItemNumber=${joined}`;

  const config = {
    method: "get",
    url,
    timeout: timeoutMs,
    headers: {
      Authorization: `Espresso ${process.env.MEYER_KEY}`,
      "Content-Type": "application/json",
    },
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.request(config);
      if (minDelayBetweenCallsMs > 0) await sleep(minDelayBetweenCallsMs);
      return res.data;
    } catch (err) {
      const retryable = isRetryableHttp(err);
      if (!retryable || attempt === maxRetries) {
        const status = err?.response?.status;
        const msg =
          err?.response?.data?.errorMessage ||
          err?.message ||
          "Unknown Meyer API error";
        return {
          statusCode: status || 500,
          errorMessage: msg,
        };
      }
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }

  return { statusCode: 500, errorMessage: "Unexpected retry loop exit" };
}

const MeyerCost = async () => {
  try {
    const totalSkus = await prisma.product.count({
      where: {
        meyer_code: {
          not: "",
        },
        brand_name: {
          // in:[ "BESTOP"]
        },
        status: 1,
      },
    });

    console.log(`Total number of products with a Meyer Code: ${totalSkus}`);

    const skus = await prisma.product.findMany({
      where: {
        meyer_code: {
          not: "",
        },
        brand_name: {
          // in:[ "BESTOP"]
        },
        status: 1,
      },
      select: {
        meyer_code: true,
      },
    });

    const batchSize = Number(process.env.MEYER_BATCH_SIZE || 100);
    const batchDelayMs = Number(process.env.MEYER_BATCH_DELAY_MS || 1000);

    const chunkedSkus = [];
    for (let i = 0; i < skus.length; i += batchSize) {
      chunkedSkus.push(skus.slice(i, i + batchSize));
    }

    const flattenedResponses = [];
    console.time("Overall execution time");

    for (let i = 0; i < chunkedSkus.length; i++) {
      const chunk = chunkedSkus[i];
      const itemNumbers = chunk.map((c) => c.meyer_code).filter(Boolean);

      console.log(`Starting batch ${i + 1}/${chunkedSkus.length} (${itemNumbers.length} items)...`);

      const data = await fetchMeyerBatch(itemNumbers, {
        timeoutMs: Number(process.env.MEYER_TIMEOUT_MS || 30000),
        maxRetries: Number(process.env.MEYER_RETRY_MAX || 5),
        baseDelayMs: Number(process.env.MEYER_RETRY_DELAY_MS || 400),
        minDelayBetweenCallsMs: Number(process.env.MEYER_MIN_DELAY_MS || 0),
      });

      if (data && data.statusCode) {
        console.log(`Batch ${i + 1} failed: ${data.errorMessage || "Unknown error"}`);
        for (const itemNumber of itemNumbers) {
          flattenedResponses.push({
            statusCode: data.statusCode,
            errorMessage: data.errorMessage,
            itemNumber,
          });
        }
      } else if (Array.isArray(data)) {
        const mergedByItemNumber = new Map();
        for (const item of data) {
          const key = normalizeItemNumber(item?.ItemNumber);
          if (!key) continue;
          mergedByItemNumber.set(key, item);
        }

        const missingBestopFallbacks = itemNumbers
          .filter((itemNumber) => !mergedByItemNumber.has(normalizeItemNumber(itemNumber)))
          .map(bestopDashlessFallback)
          .filter((fallbackCode) => fallbackCode && !mergedByItemNumber.has(normalizeItemNumber(fallbackCode)));

        if (missingBestopFallbacks.length > 0) {
          const uniqueFallbacks = Array.from(new Set(missingBestopFallbacks));
          console.log(
            `Batch ${i + 1}: retrying ${uniqueFallbacks.length} missing BST/BES item(s) without dashes...`
          );

          const fallbackChunks = chunkArray(uniqueFallbacks, 100);
          for (const fallbackChunk of fallbackChunks) {
            const fallbackData = await fetchMeyerBatch(fallbackChunk, {
              timeoutMs: Number(process.env.MEYER_TIMEOUT_MS || 30000),
              maxRetries: Number(process.env.MEYER_RETRY_MAX || 5),
              baseDelayMs: Number(process.env.MEYER_RETRY_DELAY_MS || 400),
              minDelayBetweenCallsMs: Number(process.env.MEYER_MIN_DELAY_MS || 0),
            });

            if (Array.isArray(fallbackData)) {
              for (const item of fallbackData) {
                const key = normalizeItemNumber(item?.ItemNumber);
                if (!key) continue;
                mergedByItemNumber.set(key, item);
              }
            }
          }
        }

        for (const item of mergedByItemNumber.values()) {
          flattenedResponses.push([item]);
        }
      }

      if (batchDelayMs > 0) await sleep(batchDelayMs);
    }

    console.timeEnd("Overall execution time");

    console.log(flattenedResponses);
    return flattenedResponses;
  } catch (error) {
    console.log(error);
  }
};

module.exports = MeyerCost;
