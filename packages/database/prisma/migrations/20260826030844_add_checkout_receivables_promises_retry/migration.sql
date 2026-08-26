-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "items" JSONB,
    "status" TEXT NOT NULL,
    "abandonmentReason" TEXT,
    "recoveryChannel" TEXT,
    "incentiveType" TEXT,
    "incentiveValue" JSONB,
    "recoveredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "overdueDays" INTEGER NOT NULL DEFAULT 0,
    "agingBucket" TEXT,
    "lastChasedAt" TIMESTAMP(3),
    "chaseCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "installments" JSONB NOT NULL,
    "currentInstallment" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromiseToPay" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT,
    "merchantId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "promisedAmount" INTEGER NOT NULL,
    "promisedDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT,
    "agentNotes" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "extendedDate" TIMESTAMP(3),
    "keptAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromiseToPay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetrySchedule" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "failureCategory" TEXT NOT NULL,
    "retryWindow" JSONB NOT NULL,
    "currentRetry" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3) NOT NULL,
    "lastRetryAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetrySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_sessionId_key" ON "CheckoutSession"("sessionId");

-- CreateIndex
CREATE INDEX "CheckoutSession_merchantId_status_idx" ON "CheckoutSession"("merchantId", "status");

-- CreateIndex
CREATE INDEX "CheckoutSession_sessionId_idx" ON "CheckoutSession"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Invoice_merchantId_status_idx" ON "Invoice"("merchantId", "status");

-- CreateIndex
CREATE INDEX "Invoice_merchantId_overdueDays_idx" ON "Invoice"("merchantId", "overdueDays");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_invoiceId_key" ON "PaymentPlan"("invoiceId");

-- CreateIndex
CREATE INDEX "PromiseToPay_merchantId_status_idx" ON "PromiseToPay"("merchantId", "status");

-- CreateIndex
CREATE INDEX "PromiseToPay_invoiceId_idx" ON "PromiseToPay"("invoiceId");

-- CreateIndex
CREATE INDEX "PromiseToPay_promisedDate_idx" ON "PromiseToPay"("promisedDate");

-- CreateIndex
CREATE UNIQUE INDEX "RetrySchedule_caseId_key" ON "RetrySchedule"("caseId");

-- CreateIndex
CREATE INDEX "RetrySchedule_merchantId_status_idx" ON "RetrySchedule"("merchantId", "status");

-- CreateIndex
CREATE INDEX "RetrySchedule_nextRetryAt_idx" ON "RetrySchedule"("nextRetryAt");

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromiseToPay" ADD CONSTRAINT "PromiseToPay_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromiseToPay" ADD CONSTRAINT "PromiseToPay_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrySchedule" ADD CONSTRAINT "RetrySchedule_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
