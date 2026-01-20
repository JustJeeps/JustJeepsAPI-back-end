/*
  Warnings:

  - You are about to drop the column `meyr_width` on the `Product` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "meyr_width",
ADD COLUMN     "meyer_width" DOUBLE PRECISION;
