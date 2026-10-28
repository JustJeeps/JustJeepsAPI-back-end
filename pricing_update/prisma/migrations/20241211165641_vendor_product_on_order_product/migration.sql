-- AlterTable
ALTER TABLE "OrderProduct" ADD COLUMN     "vendor_product_id" INTEGER;

-- AddForeignKey
ALTER TABLE "OrderProduct" ADD CONSTRAINT "OrderProduct_vendor_product_id_fkey" FOREIGN KEY ("vendor_product_id") REFERENCES "VendorProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
