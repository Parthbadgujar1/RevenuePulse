-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "retentionPolicy" JSONB NOT NULL DEFAULT '{"transactionsMonths":36,"auditLogsMonths":12,"appLogsDays":30,"notificationsDays":90,"tempJobsDays":7}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "merchantId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "summary" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "merchantId" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentialsRef" TEXT,
    "keyId" TEXT,
    "keySecretEncrypted" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "mode" TEXT,
    "displayName" TEXT,
    "webhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentMethodDetails" JSONB,
    "failureCode" TEXT,
    "failureCategory" TEXT,
    "failureMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawEventRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "webhookEventId" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueCase" (
    "id" TEXT NOT NULL,
    "ref" TEXT,
    "transactionId" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "amountAtRisk" INTEGER NOT NULL,
    "diagnosis" JSONB,
    "priority" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "currentActionId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "expectedValue" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION,
    "featureSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "expectedCost" INTEGER NOT NULL,
    "expectedNetRecovery" INTEGER NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "approverId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executionStatus" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerActionId" TEXT,
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "outcomeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "recoveredAmount" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "recoveryTimestamp" TIMESTAMP(3) NOT NULL,
    "measuredCost" INTEGER NOT NULL,
    "notes" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "policyResult" JSONB,
    "beforeState" JSONB,
    "afterState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "baselineMetrics" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_key" ON "WebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_providerTransactionId_key" ON "Transaction"("providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_webhookEventId_key" ON "Transaction"("webhookEventId");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueCase_ref_key" ON "RevenueCase"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueCase_transactionId_key" ON "RevenueCase"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_caseId_key" ON "Prediction"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAction_idempotencyKey_key" ON "RecoveryAction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAction_outcomeId_key" ON "RecoveryAction"("outcomeId");

-- CreateIndex
CREATE INDEX "RecoveryAction_caseId_idx" ON "RecoveryAction"("caseId");

-- CreateIndex
CREATE INDEX "RecoveryAction_executionStatus_idx" ON "RecoveryAction"("executionStatus");

-- CreateIndex
CREATE INDEX "RecoveryAction_idempotencyKey_idx" ON "RecoveryAction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Outcome_actionId_key" ON "Outcome"("actionId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueCase" ADD CONSTRAINT "RevenueCase_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueCase" ADD CONSTRAINT "RevenueCase_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "RecoveryAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
