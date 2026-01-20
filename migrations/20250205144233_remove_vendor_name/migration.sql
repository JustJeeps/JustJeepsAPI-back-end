/*
  Warnings:

  - You are about to drop the column `vendor_name` on the `VendorProduct` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "VendorProduct" DROP CONSTRAINT "VendorProduct_vendor_id_vendor_name_fkey";

-- DropIndex
DROP INDEX "Vendor_id_name_key";

-- AlterTable
ALTER TABLE "VendorProduct" DROP COLUMN "vendor_name";

-- AddForeignKey
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
