-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "email_first_seen" TEXT,
ALTER COLUMN "updated_at" SET DEFAULT now()::text;
