const DEFAULT_USD_TO_CAD_RATE = 1.55;

function parsePositiveNumber(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

const USD_TO_CAD_RATE =
  parsePositiveNumber(process.env.USD_TO_CAD_RATE) || DEFAULT_USD_TO_CAD_RATE;

module.exports = {
  USD_TO_CAD_RATE,
  DEFAULT_USD_TO_CAD_RATE,
};
