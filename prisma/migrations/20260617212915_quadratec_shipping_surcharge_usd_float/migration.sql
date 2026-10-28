-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updated_at" SET DEFAULT now()::text;

-- AlterTable
ALTER TABLE "VendorProduct" ADD COLUMN     "quadratec_shipping_surcharge_usd" DOUBLE PRECISION;
