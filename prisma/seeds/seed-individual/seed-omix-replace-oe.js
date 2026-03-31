const path = require("path");
const XLSX = require("xlsx");
const prisma = require("../../../lib/prisma");

const FILE_PATH = path.join(
  __dirname,
  "../api-calls/omix-oe-replace-file.xlsx"
);
const IN_QUERY_CHUNK_SIZE = 1000;

const chunkArray = (items, chunkSize) => {
  if (!items.length) return [];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const readReplaceOeMap = () => {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });

  const replaceMap = new Map();

  for (const row of rows) {
    const itemRaw = row["item"] || row["Item"] || row["ITEM"];
    const oeRefRaw =
      row["OE Ref"] || row["OE REF"] || row["Oe Ref"] || row["oe ref"];

    const item = itemRaw == null ? "" : String(itemRaw).trim();
    const oeRef = oeRefRaw == null ? "" : String(oeRefRaw).trim();

    if (!item || !oeRef) {
      continue;
    }

    if (!replaceMap.has(item) || !replaceMap.get(item)) {
      replaceMap.set(item, oeRef);
    }
  }

  return replaceMap;
};

const seedOmixReplaceOe = async () => {
  try {
    const startedAt = Date.now();
    const replaceMap = readReplaceOeMap();
    const items = Array.from(replaceMap.keys());

    if (items.length === 0) {
      console.log("No replace OE rows found to seed.");
      return;
    }

    const updateSql = `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          searchable_sku text,
          replace_oe text
        )
      )
      UPDATE "Product" p
      SET replace_oe = input.replace_oe
      FROM input
      WHERE p.searchable_sku = input.searchable_sku
        AND p.vendors ILIKE '%omix-ada%';
    `;

    let updatedTotal = 0;

    for (const chunk of chunkArray(items, IN_QUERY_CHUNK_SIZE)) {
      const payloadRows = chunk
        .map((item) => ({
          searchable_sku: item,
          replace_oe: replaceMap.get(item),
        }))
        .filter((row) => row.searchable_sku && row.replace_oe);

      if (!payloadRows.length) {
        continue;
      }

      const updatedCount = await prisma.$executeRawUnsafe(
        updateSql,
        JSON.stringify(payloadRows)
      );

      updatedTotal += Number(updatedCount || 0);
    }

    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `Updated replace_oe for ${updatedTotal} Omix products in ${durationSeconds}s.`
    );
  } catch (error) {
    console.error("Error seeding replace_oe values:", error);
  } finally {
    await prisma.$disconnect();
  }
};

seedOmixReplaceOe();
