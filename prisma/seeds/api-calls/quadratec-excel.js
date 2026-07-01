const XLSX = require("xlsx");
const path = require("path");

function normalizeText(value) {
  return (value ?? "").toString().trim();
}

function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = normalizeText(value);
  if (!text || text.toLowerCase() === "- none -") return null;

  const normalized = text.replace(/[$,]/g, "");
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return direct;

  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function normalizeQuadratecPrices(wholesalePrice, retailPrice) {
  const hasWholesale = Number.isFinite(wholesalePrice);
  const hasRetail = Number.isFinite(retailPrice);

  // Feed anomaly guard: some rows have wholesale/retail swapped.
  // When both are present and wholesale is greater than retail,
  // treat them as swapped and correct in-memory before seeding.
  if (hasWholesale && hasRetail && wholesalePrice > retailPrice) {
    return {
      wholesalePrice: retailPrice,
      retailPrice: wholesalePrice,
      prices_swapped: true,
    };
  }

  return {
    wholesalePrice,
    retailPrice,
    prices_swapped: false,
  };
}

function startsWithQtc(value) {
  return normalizeText(value).toUpperCase().startsWith("QTC-");
}

function isAccuPartLikeBrand(brand) {
  const normalized = normalizeText(brand).toLowerCase();
  return (
    normalized === "accupart" ||
    normalized === "accu part" ||
    normalized === "acuupart"
  );
}

function isStealthBrand(brand) {
  return normalizeText(brand).toLowerCase() === "stealth";
}

function shouldEmitQuadratecFallbackForBrand(brand) {
  const normalized = normalizeText(brand).toLowerCase();
  return (
    normalized === "accupart" ||
    normalized === "accu part" ||
    normalized === "acuupart" ||
    normalized === "stealth" ||
    normalized === "tactik" ||
    normalized === "carnivore" ||
    normalized === "tru-fit" ||
    normalized === "lynx" ||
    normalized === "kicker" ||
    normalized === "res-q" ||
    normalized === "performance tool"
  );
}

function withQtcPrefix(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (startsWithQtc(text)) return text.toUpperCase();

  const hyphenated = text.replace(/\s+/g, "-");
  if (startsWithQtc(hyphenated)) return hyphenated.toUpperCase();

  return `QTC-${hyphenated}`.toUpperCase();
}

function shouldForceQuadratecBrand(brand, mpn, quadPn) {
  if (!isAccuPartLikeBrand(brand) && !isStealthBrand(brand)) return false;
  return startsWithQtc(mpn) || startsWithQtc(quadPn);
}

function isAccuPartBrand(brand) {
  return isAccuPartLikeBrand(brand);
}

function isPoisonSpyderBrand(brand) {
  const normalized = normalizeText(brand).toLowerCase();
  return normalized === "poison spyder" || normalized === "poison spyder customs";
}

function toPoisonSpyderDashedPartNumber(value) {
  const text = normalizeText(value);
  if (!text || text.includes("-")) return text;

  const compact = text.replace(/\s+/g, "");
  if (!/^[a-z0-9]+$/i.test(compact) || compact.length < 7) return text;

  return `${compact.slice(0, 2)}-${compact.slice(2, 4)}-${compact.slice(4)}`;
}

const quadratecCost = () => {
  // Step 1: Load Excel file
  // Construct the absolute file path using __dirname and the file name
  const filePath = path.join(__dirname, "pricingSheet_quad.xlsx");

  // Read the file using the updated file path
  const workbook = XLSX.readFile(filePath);

  // Step 2: Extract Sheet Data
  const sheetName = workbook.SheetNames[0]; // assuming you want to read the first sheet
  const sheet = workbook.Sheets[sheetName];

  // Define custom header array
  const customHeader = [
    "Quadratec PN",
    "MPN",
    "Description",
    "UPC Code",
    "Brand",
    "Retail Price",
    "Wholesale Price",
    "Shipping Surcharge",
  ];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: customHeader });

  // Step 3: Access JSON Data
  const finalResults = jsonData.slice(1).map((obj) => {
    const originalBrand = normalizeText(obj["Brand"]);
    const mpn = normalizeText(obj["MPN"]);
    const quadPn = normalizeText(obj["Quadratec PN"]);
    const forcedQuadratecBrand = shouldForceQuadratecBrand(originalBrand, mpn, quadPn);
    const brand = forcedQuadratecBrand ? "Quadratec" : originalBrand;

    const useQuadratecPnForBrand =
      brand === "Quadratec" ||
      brand === "QuadraTop" ||
      brand === "TACTIK" ||
      brand === "Tecstyle" ||
      brand === "Diver Down" ||
      brand === "RES-Q" ||
      brand === "Lynx" ||
      brand === "Tom Woods" ||
      brand === "Tru-Fit" ||
      brand === "Carnivore" ||
      brand === "Seatbelt Solutions" ;


    // Some products for these brands use Quadratec PN, others use MPN.
    // Emit both codes so the seeder can match either.
    let quadratecCode = "";
    let quadratecCodeAlt = "";

    if (useQuadratecPnForBrand) {
      quadratecCode = brand + quadPn;
      if (mpn && mpn !== quadPn) {
        quadratecCodeAlt = brand + mpn;
      }
    } else {
      quadratecCode = brand + mpn;
      if (quadPn && quadPn !== mpn) {
        quadratecCodeAlt = brand + quadPn;
      }
    }

    let quadratecCodeAlt2 = null;
    let quadratecCodeAlt3 = null;
    let quadratecCodeAlt4 = null;
    let quadratecCodeAlt5 = null;
    let quadratecCodeAlt6 = null;
    let quadratecCodeAlt7 = null;
    let quadratecCodeAlt8 = null;
    let quadratecCodeAlt9 = null;
    let quadratecCodeAlt10 = null;
    let quadratecCodeAlt11 = null;
    let quadratecCodeAlt12 = null;

    if (!forcedQuadratecBrand && isAccuPartBrand(originalBrand)) {
      if (quadPn) {
        quadratecCodeAlt2 = `Quadratec${quadPn}`;
      }
      if (mpn && startsWithQtc(mpn)) {
        quadratecCodeAlt3 = `Quadratec${mpn}`;
      }
    }

    if (isPoisonSpyderBrand(brand)) {
      const dashedMpn = toPoisonSpyderDashedPartNumber(mpn);
      const dashedQuadPn = toPoisonSpyderDashedPartNumber(quadPn);

      if (dashedMpn && dashedMpn !== mpn) {
        quadratecCodeAlt4 = `${brand}${dashedMpn}`;
      }

      if (
        dashedQuadPn &&
        dashedQuadPn !== quadPn &&
        `${brand}${dashedQuadPn}` !== quadratecCodeAlt4
      ) {
        quadratecCodeAlt5 = `${brand}${dashedQuadPn}`;
      }
    }

    if (isStealthBrand(originalBrand)) {
      const qtcFromQuadPn = withQtcPrefix(quadPn);
      const qtcFromMpn = withQtcPrefix(mpn);

      if (quadPn) {
        quadratecCodeAlt8 = `Quadratec${quadPn}`;
      }

      if (qtcFromQuadPn) {
        quadratecCodeAlt9 = `Quadratec${qtcFromQuadPn}`;
      }

      if (qtcFromQuadPn) {
        quadratecCodeAlt6 = `Stealth${qtcFromQuadPn}`;
      }

      if (
        qtcFromMpn &&
        `Stealth${qtcFromMpn}` !== quadratecCodeAlt6
      ) {
        quadratecCodeAlt7 = `Stealth${qtcFromMpn}`;
      }
    }

    if (!forcedQuadratecBrand && shouldEmitQuadratecFallbackForBrand(originalBrand)) {
      const existingCodes = new Set(
        [
          quadratecCode,
          quadratecCodeAlt,
          quadratecCodeAlt2,
          quadratecCodeAlt3,
          quadratecCodeAlt4,
          quadratecCodeAlt5,
          quadratecCodeAlt6,
          quadratecCodeAlt7,
          quadratecCodeAlt8,
          quadratecCodeAlt9,
        ].filter(Boolean)
      );

      const rawFallbacks = [
        quadPn ? `Quadratec${quadPn}` : null,
        startsWithQtc(mpn) ? `Quadratec${mpn}` : null,
        withQtcPrefix(quadPn) ? `Quadratec${withQtcPrefix(quadPn)}` : null,
        withQtcPrefix(mpn) ? `Quadratec${withQtcPrefix(mpn)}` : null,
      ]
        .filter(Boolean)
        .filter((code, index, arr) => arr.indexOf(code) === index)
        .filter((code) => !existingCodes.has(code));

      quadratecCodeAlt10 = rawFallbacks[0] || null;
      quadratecCodeAlt11 = rawFallbacks[1] || null;
      quadratecCodeAlt12 = rawFallbacks[2] || null;
    }

    const wholesalePriceRaw = parseMoney(obj["Wholesale Price"]);
    const shippingSurcharge = parseMoney(obj["Shipping Surcharge"]);
    const retailPriceRaw = parseMoney(obj["Retail Price"]);
    const normalizedPrices = normalizeQuadratecPrices(
      wholesalePriceRaw,
      retailPriceRaw
    );

    return {
      MPN: mpn,
      brand,
      original_brand: originalBrand,
      forced_quadratec_brand: forcedQuadratecBrand,
      wholesalePrice: normalizedPrices.wholesalePrice,
      shippingSurcharge,
      retailPrice: normalizedPrices.retailPrice,
      prices_swapped: normalizedPrices.prices_swapped,
      quadratec_code: quadratecCode,
      quadratec_code_alt: quadratecCodeAlt || null,
      quadratec_code_alt2: quadratecCodeAlt2,
      quadratec_code_alt3: quadratecCodeAlt3,
      quadratec_code_alt4: quadratecCodeAlt4,
      quadratec_code_alt5: quadratecCodeAlt5,
      quadratec_code_alt6: quadratecCodeAlt6,
      quadratec_code_alt7: quadratecCodeAlt7,
      quadratec_code_alt8: quadratecCodeAlt8,
      quadratec_code_alt9: quadratecCodeAlt9,
      quadratec_code_alt10: quadratecCodeAlt10,
      quadratec_code_alt11: quadratecCodeAlt11,
      quadratec_code_alt12: quadratecCodeAlt12,
      quadratec_sku: quadPn,
    };
  });

  // const finalResults = jsonData
  //   .slice(1)
  //   .map((obj) => {
  //     return {
  //       "MPN": obj["MPN"].toString(),
  //       "brand": obj["Brand"],
  //       "wholesalePrice": obj["Wholesale Price"],
  //       "retailPrice": obj["Retail Price"],
  //       "quadratec_code": obj["Brand"].toString() + obj["MPN"].toString()

  //     };
  //   });
  if (process.env.DEBUG_QUADRATEC_EXCEL === "1") {
    console.log("from api-calls", finalResults);
  }
  return finalResults;
};

// Only run if called directly (not when imported)
if (require.main === module) {
  quadratecCost();
}

module.exports = quadratecCost;
