-- AlterTable
ALTER TABLE "OrderProduct" ADD COLUMN     "addedBy" TEXT;

-- CreateIndex
CREATE INDEX "Order_created_at_idx" ON "Order"("created_at");

-- CreateIndex
CREATE INDEX "OrderProduct_order_id_idx" ON "OrderProduct"("order_id");

-- CreateIndex
CREATE INDEX "OrderProduct_sku_idx" ON "OrderProduct"("sku");
