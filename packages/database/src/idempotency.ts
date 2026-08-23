// Idempotency Layer - Durable, database-owned webhook state machine.
//
// States: RECEIVED -> PROCESSING -> PROCESSED | FAILED
// The unique constraint on providerEventId guarantees exactly-once ingestion;
// completion is recorded ONLY after the recovery workflow succeeds.
// A FAILED row may be retried (retryCount incremented).

import { PrismaClient } from '../prisma/generated/prisma/client';
import { createHash } from 'crypto';

export type WebhookStatus = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface IdempotencyRecord {
  key: string;
  entityType: string;
  entityId: string;
  acquiredAt: Date;
  completedAt?: Date;
  result?: string;
}

export function hashPayload(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Ensure the singleton demo merchant exists (FK target for pipeline writes).
 */
export async function ensureDemoMerchant(
  prisma: PrismaClient,
  merchantId = 'demo-merchant'
): Promise<string> {
  await prisma.merchant.upsert({
    where: { id: merchantId },
    update: {},
    create: {
      id: merchantId,
      name: 'Demo Merchant',
      currency: 'INR',
      createdAt: new Date(),
    },
  });
  return merchantId;
}

/**
 * Register an inbound webhook durably. Returns the created row id, or null
 * if this providerEventId was already registered (duplicate delivery).
 */
export async function registerWebhookEvent(
  prisma: PrismaClient,
  input: {
    providerEventId: string;
    eventType: string;
    rawBody: string;
    summary?: Record<string, unknown>;
    merchantId?: string;
  }
): Promise<{ id: string; duplicate: boolean }> {
  try {
    const row = await prisma.webhookEvent.create({
      data: {
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payloadHash: hashPayload(input.rawBody),
        status: 'RECEIVED',
        summary: (input.summary ?? undefined) as any,
        merchantId: input.merchantId ?? null,
      },
    });
    return { id: row.id, duplicate: false };
  } catch (error) {
    // Unique violation => duplicate delivery
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { providerEventId: input.providerEventId },
        select: { id: true },
      });
      return { id: existing?.id ?? '', duplicate: true };
    }
    throw error;
  }
}

export async function markWebhookProcessing(prisma: PrismaClient, id: string): Promise<void> {
  if (!id) return;
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: 'PROCESSING' },
  });
}

export async function markWebhookProcessed(prisma: PrismaClient, id: string): Promise<void> {
  if (!id) return;
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: 'PROCESSED', processedAt: new Date() },
  });
}

export async function markWebhookFailed(
  prisma: PrismaClient,
  id: string,
  errorMessage: string
): Promise<void> {
  if (!id) return;
  const current = await prisma.webhookEvent.findUnique({
    where: { id },
    select: { retryCount: true },
  });
  await prisma.webhookEvent.update({
    where: { id },
    data: {
      status: 'FAILED',
      error: errorMessage.slice(0, 500),
      retryCount: (current?.retryCount ?? 0) + 1,
    },
  });
}
