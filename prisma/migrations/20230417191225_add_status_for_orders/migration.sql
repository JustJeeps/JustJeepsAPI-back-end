/*
  Warnings:

  - You are about to drop the column `producr_url` on the `CompetitorProduct` table. All the data in the column will be lost.
  - Changed the type of `competitor_price` on the `CompetitorProduct` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "CompetitorProduct" DROP COLUMN "producr_url",
ADD COLUMN     "product_url" TEXT,
DROP COLUMN "competitor_price",
ADD COLUMN     "competitor_price" DOUBLE PRECISION NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "status" TEXT;
