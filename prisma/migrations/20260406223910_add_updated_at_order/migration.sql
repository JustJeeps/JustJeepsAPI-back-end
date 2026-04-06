-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "updated_at" TEXT NOT NULL DEFAULT now()::text;
