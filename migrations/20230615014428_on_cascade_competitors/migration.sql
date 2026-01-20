-- DropForeignKey
ALTER TABLE "CompetitorProduct" DROP CONSTRAINT "CompetitorProduct_product_sku_fkey";

-- AddForeignKey
ALTER TABLE "CompetitorProduct" ADD CONSTRAINT "CompetitorProduct_product_sku_fkey" FOREIGN KEY ("product_sku") REFERENCES "Product"("sku") ON DELETE CASCADE ON UPDATE CASCADE;
