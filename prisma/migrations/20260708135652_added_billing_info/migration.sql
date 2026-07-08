-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "billing_city" TEXT,
ADD COLUMN     "billing_country_id" TEXT,
ADD COLUMN     "billing_postcode" TEXT,
ADD COLUMN     "billing_region" TEXT,
ADD COLUMN     "billing_street" TEXT,
ALTER COLUMN "updated_at" SET DEFAULT now()::text;
