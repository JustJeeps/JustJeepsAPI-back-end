const MeyerCost = require("./meyer-api.js");

async function MeyerCostUs() {
  const previousKey = process.env.MEYER_KEY;

  try {
    process.env.MEYER_KEY = process.env.meyer_key_us || process.env.MEYER_KEY_US || "";

    if (!process.env.MEYER_KEY) {
      throw new Error("Missing Meyer US API key. Set meyer_key_us or MEYER_KEY_US in environment.");
    }

    return await MeyerCost();
  } finally {
    process.env.MEYER_KEY = previousKey;
  }
}

module.exports = MeyerCostUs;
