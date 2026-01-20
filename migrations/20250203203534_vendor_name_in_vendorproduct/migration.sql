/*
  Warnings:

  - A unique constraint covering the columns `[id,name]` on the table `Vendor` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "VendorProduct" DROP CONSTRAINT "VendorProduct_vendor_id_fkey";

-- AlterTable
ALTER TABLE "VendorProduct" ADD COLUMN     "vendor_name" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_id_name_key" ON "Vendor"("id", "name");

-- AddForeignKey
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_vendor_id_vendor_name_fkey" FOREIGN KEY ("vendor_id", "vendor_name") REFERENCES "Vendor"("id", "name") ON DELETE RESTRICT ON UPDATE CASCADE;
