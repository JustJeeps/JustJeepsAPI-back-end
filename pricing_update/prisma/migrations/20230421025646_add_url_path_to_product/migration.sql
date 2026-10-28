-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "url_path" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLineItem" ALTER COLUMN "vendor_cost" DROP NOT NULL;
