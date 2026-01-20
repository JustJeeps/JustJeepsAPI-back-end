/*
  Warnings:

  - You are about to drop the column `lack_friday_sale` on the `Product` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "lack_friday_sale",
ADD COLUMN     "black_friday_sale" TEXT;
