-- DropForeignKey
ALTER TABLE "PurchaseOrderLineItem" DROP CONSTRAINT "PurchaseOrderLineItem_vendor_product_id_fkey";

-- AlterTable
ALTER TABLE "PurchaseOrderLineItem" ADD COLUMN     "product_sku" TEXT,
ADD COLUMN     "vendor_sku" TEXT;
