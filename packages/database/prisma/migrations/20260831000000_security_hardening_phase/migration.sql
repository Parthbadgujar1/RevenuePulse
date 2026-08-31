-- Security hardening pass:
-- 1. Drop the legacy plaintext webhook secret (only AES-256-GCM encrypted storage is trusted).
-- 2. Scope invoice numbers per merchant (removes global collision).
-- 3. Scope checkout sessions per merchant (defense in depth against the
--    cross-tenant upsert path).

-- Drop the legacy plaintext webhook secret column.
ALTER TABLE "ProviderConnection" DROP COLUMN IF EXISTS "webhookSecret";

-- Invoice numbers become unique per merchant. invoiceNumber was previously
-- globally unique, so no duplicate invoiceNumber exists today within any
-- merchant; the composite index restores per-merchant uniqueness cleanly.
DROP INDEX IF EXISTS "Invoice_invoiceNumber_key";
CREATE UNIQUE INDEX "Invoice_merchantId_invoiceNumber_key" ON "Invoice" ("merchantId", "invoiceNumber");

-- Checkout sessions become unique per merchant for tenant isolation.
-- sessionId remains indexed (the original @@index([sessionId]) already
-- produced CheckoutSession_sessionId_idx, so it is not recreated).
DROP INDEX IF EXISTS "CheckoutSession_sessionId_key";
CREATE UNIQUE INDEX "CheckoutSession_merchantId_sessionId_key" ON "CheckoutSession" ("merchantId", "sessionId");
