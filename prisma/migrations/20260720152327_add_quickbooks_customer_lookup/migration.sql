-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updated_at" SET DEFAULT now()::text;

-- CreateTable
CREATE TABLE "QuickBooksImport" (
    "id" SERIAL NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceExportedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "customers" INTEGER NOT NULL DEFAULT 0,
    "transactionsGroupedCustomers" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,

    CONSTRAINT "QuickBooksImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksCustomer" (
    "id" SERIAL NOT NULL,
    "importId" INTEGER NOT NULL,
    "customerCode" TEXT NOT NULL,
    "searchName" TEXT NOT NULL DEFAULT '',
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "companyName" TEXT NOT NULL DEFAULT '',
    "invoiceTo" TEXT NOT NULL DEFAULT '',
    "invoiceToAddress" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "phoneDigits" TEXT NOT NULL DEFAULT '',
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "street1" TEXT NOT NULL DEFAULT '',
    "street2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "province" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "displayName" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "searchNameNorm" TEXT NOT NULL DEFAULT '',
    "displayNameNorm" TEXT NOT NULL DEFAULT '',
    "emailNorm" TEXT NOT NULL DEFAULT '',
    "addressNorm" TEXT NOT NULL DEFAULT '',
    "codeNorm" TEXT NOT NULL DEFAULT '',
    "codeSort" TEXT NOT NULL DEFAULT '',
    "phoneSearch" TEXT NOT NULL DEFAULT '',
    "phoneSortDigits" TEXT NOT NULL DEFAULT '',
    "hasPurchasedBefore" BOOLEAN NOT NULL DEFAULT false,
    "invoiceCount" INTEGER NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmountPurchased" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCreditAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lifetimeValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "firstPurchaseDate" TEXT,
    "lastPurchaseDate" TEXT,
    "lastPurchaseSortAt" TIMESTAMP(3) NOT NULL,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "recentTransactions" JSONB,

    CONSTRAINT "QuickBooksCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickBooksImport_status_id_idx" ON "QuickBooksImport"("status", "id");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_displayNameNorm_idx" ON "QuickBooksCustomer"("importId", "displayNameNorm");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_emailNorm_idx" ON "QuickBooksCustomer"("importId", "emailNorm");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_addressNorm_idx" ON "QuickBooksCustomer"("importId", "addressNorm");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_lifetimeValue_idx" ON "QuickBooksCustomer"("importId", "lifetimeValue");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_invoiceCount_idx" ON "QuickBooksCustomer"("importId", "invoiceCount");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_paymentCount_idx" ON "QuickBooksCustomer"("importId", "paymentCount");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_lastPurchaseSortAt_idx" ON "QuickBooksCustomer"("importId", "lastPurchaseSortAt");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_phoneSortDigits_idx" ON "QuickBooksCustomer"("importId", "phoneSortDigits");

-- CreateIndex
CREATE INDEX "QuickBooksCustomer_importId_codeSort_idx" ON "QuickBooksCustomer"("importId", "codeSort");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksCustomer_importId_customerCode_key" ON "QuickBooksCustomer"("importId", "customerCode");
