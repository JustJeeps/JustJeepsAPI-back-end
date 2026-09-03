-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updated_at" SET DEFAULT now()::text;
