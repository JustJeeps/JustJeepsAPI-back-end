const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const prisma = new PrismaClient();

const COMPETITOR_ID = 3; // PartsEngine
const FILE_PATH = path.join(__dirname, "results.csv");

async function seedPartsEngineCompetitorProducts() {
  const results = [];

  fs.createReadStream(FILE_PATH)
    .pipe(csv())
    .on("data", (row) => results.push(row))
    .on("end", async () => {
      let created = 0;
      let updated = 0;

      for (const row of results) {
        const url = row.URL?.trim();
        const competitorSku = row.SKU?.trim();
        const competitorPrice = parseFloat(row.Price?.trim());

        if (!url || isNaN(competitorPrice)) {
          console.warn(`⚠️ Skipping invalid row:`, row);
          continue;
        }

        const product = await prisma.product.findFirst({
          where: { partsEngine_code: url },
        });

        if (!product) {
          console.warn(`⚠️ No match for partsEngine_code: ${url}`);
          continue;
        }

        // Check if a CompetitorProduct already exists
        const existing = await prisma.competitorProduct.findFirst({
          where: {
            product_sku: product.sku,
            competitor_id: COMPETITOR_ID,
          },
        });

        if (existing) {
          await prisma.competitorProduct.update({
            where: { id: existing.id },
            data: {
              competitor_price: competitorPrice,
              competitor_sku: competitorSku,
              product_url: url,
            },
          });
          updated++;
          console.log(`🔁 Updated: ${competitorSku} → ${product.sku}`);
        } else {
          await prisma.competitorProduct.create({
            data: {
              product_sku: product.sku,
              competitor_id: COMPETITOR_ID,
              competitor_price: competitorPrice,
              competitor_sku: competitorSku,
              product_url: url,
            },
          });
          created++;
          console.log(`✅ Created: ${competitorSku} → ${product.sku}`);
        }
      }

      console.log(`🎯 Done! ${created} created, ${updated} updated.`);
      await prisma.$disconnect();
    });
}

seedPartsEngineCompetitorProducts();
