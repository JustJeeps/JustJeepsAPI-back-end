-- "N OPEN ORDERS" flag on the Orders screen: /api/orders runs one extra lookup
-- per page keyed by customer_email, which had no index (only created_at did).
CREATE INDEX "Order_customer_email_idx" ON "Order"("customer_email");
