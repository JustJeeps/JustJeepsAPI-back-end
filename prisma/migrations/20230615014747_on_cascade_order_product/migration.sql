-- DropForeignKey
ALTER TABLE "OrderProduct" DROP CONSTRAINT "OrderProduct_sku_fkey";

-- AddForeignKey
ALTER TABLE "OrderProduct" ADD CONSTRAINT "OrderProduct_sku_fkey" FOREIGN KEY ("sku") REFERENCES "Product"("sku") ON DELETE CASCADE ON UPDATE CASCADE;
