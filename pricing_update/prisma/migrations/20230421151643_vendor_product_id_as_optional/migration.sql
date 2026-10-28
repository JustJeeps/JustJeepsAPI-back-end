-- DropForeignKey
ALTER TABLE "PurchaseOrderLineItem" DROP CONSTRAINT "PurchaseOrderLineItem_vendor_product_id_fkey";

-- AlterTable
ALTER TABLE "PurchaseOrderLineItem" ALTER COLUMN "vendor_product_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLineItem" ADD CONSTRAINT "PurchaseOrderLineItem_vendor_product_id_fkey" FOREIGN KEY ("vendor_product_id") REFERENCES "VendorProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
