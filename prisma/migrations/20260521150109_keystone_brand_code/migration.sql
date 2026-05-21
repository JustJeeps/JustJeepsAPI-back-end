-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updated_at" SET DEFAULT now()::text;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "keystone_brand_code" TEXT;
