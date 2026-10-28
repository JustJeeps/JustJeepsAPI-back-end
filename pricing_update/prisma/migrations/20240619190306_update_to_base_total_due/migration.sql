/*
  Warnings:

  - You are about to drop the column `total_due` on the `Order` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Order" DROP COLUMN "total_due",
ADD COLUMN     "base_total_due" DOUBLE PRECISION;
