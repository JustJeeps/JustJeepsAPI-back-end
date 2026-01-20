/*
  Warnings:

  - You are about to drop the column `t14_id` on the `VendorProduct` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "t14_id" TEXT;

-- AlterTable
ALTER TABLE "VendorProduct" DROP COLUMN "t14_id";
