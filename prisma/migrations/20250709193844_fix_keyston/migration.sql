/*
  Warnings:

  - You are about to drop the column `keyston_code_site` on the `Product` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "keyston_code_site",
ADD COLUMN     "keystone_code_site" TEXT;
