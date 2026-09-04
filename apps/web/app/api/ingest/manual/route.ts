import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@rp/database';
import { processJob, JobType } from '@rp/observability';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface ManualPayment {
  providerTxnId?: string;
  amount: number | string;
  currency?: string;
  status?: string;
  method?: string;
  errorCode?: string;
  errorDescription?: string;
  createdAt?: string;
  email?: string;
  phone?: string;
}

const MAX_BATCH = 25;

/** Build the same Razorpay-shaped raw event the CSV/Excel path produces. */
function toRawEvent(p: ManualPayment, fallbackIndex: number): Record<string, unknown> | null {
  const amountNum = typeof p.amount === 'number' ? p.amount : parseFloat(String(p.amount).replace(/[₹,\s]/gi, ''));
  if (!Number.isFinite(amountNum) || amountNum <= 0) return null;

  const paise = Math.round(amountNum * 100);
  const statusRaw = (p.status || 'failed').trim().toLowerCase();
  const eventType = /^(captured|success|succeeded|completed|paid|authorized)/i.test(statusRaw)
    ? 'payment_captured'
    : 'payment_failed';

  const timeCreated =
    p.createdAt && !Number.isNaN(new Date(p.createdAt).getTime())
      ? new Date(p.createdAt).toISOString()
      : new Date().toISOString();

  const id = (p.providerTxnId || '').trim() || `manual_${Date.now()}_${fallbackIndex}`;

  return {
    event: eventType,
    data: {
      id,
      amount: paise,
      currency: (p.currency || 'INR').toUpperCase(),
      status: eventType === 'payment_captured' ? 'captured' : 'failed',
      method: (p.method || 'unknown').toLowerCase().replace(/\s+/g, '_'),
      error: {
        code: p.errorCode?.trim() || undefined,
        description: p.errorDescription?.trim() || 'manually entered failure (no description provided)',
      },
      time_created: timeCreated,
      email: p.email?.trim() || undefined,
      contact: p.phone?.trim() || undefined,
    },
  };
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'ingest-manual', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: { payment?: ManualPayment; payments?: ManualPayment[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Expected a JSON body', details: {} } },
      { status: 400 }
    );
  }

  const input = Array.isArray(body?.payments)
    ? body.payments
    : body?.payment
      ? [body.payment]
      : [];

  if (input.length === 0) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Provide a payment to add', details: {} } },
      { status: 400 }
    );
  }
  if (input.length > MAX_BATCH) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: `Batch too large (max ${MAX_BATCH})`, details: {} } },
      { status: 400 }
    );
  }

  const { merchantId } = ctx;
  const cohortStart = new Date();
  let processed = 0;
  let duplicatesSkipped = 0;
  let pipelineErrors = 0;

  for (let i = 0; i < input.length; i++) {
    const rawEvent = toRawEvent(input[i], i);
    if (!rawEvent) {
      pipelineErrors++;
      continue;
    }

    const providerEventId = `manual:${merchantId}:${(rawEvent.data as any).id}`;
    const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
    if (existing) {
      duplicatesSkipped++;
      continue;
    }

    const normalized = normalizeRazorpayEvent(rawEvent);
    // A successful/captured payment has nothing to recover — record it as
    // context but skip the recovery pipeline.
    if (normalized.eventType !== 'payment_failed') {
      await prisma.webhookEvent.create({
        data: {
          providerEventId,
          eventType: normalized.eventType,
          payloadHash: `sha:${normalized.safeMetadata.providerTransactionId}`,
          status: 'RECEIVED',
          merchantId,
        },
      });
      processed++;
      continue;
    }

    const webhookRow = await prisma.webhookEvent.create({
      data: {
        providerEventId,
        eventType: normalized.eventType,
        payloadHash: `sha:${normalized.safeMetadata.providerTransactionId}`,
        status: 'RECEIVED',
        merchantId,
      },
    });
    const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
      merchantId,
      event: normalized,
      eventRef: webhookRow.id,
      webhookEventId: webhookRow.id,
      source: 'manual',
      simulated: true,
    });
    if (result.success) processed++;
    else pipelineErrors++;
  }

  const cohortCases = await prisma.revenueCase.findMany({
    where: { merchantId, createdAt: { gte: cohortStart } },
    select: { id: true, status: true },
  });
  const actionsCreated = await prisma.recoveryAction.count({
    where: { caseId: { in: cohortCases.map((c) => c.id) }, createdAt: { gte: cohortStart } },
  });

  return NextResponse.json({
    success: true,
    data: {
      submitted: input.length,
      processed,
      duplicatesSkipped,
      pipelineErrors,
      casesCreated: cohortCases.length,
      actionsCreated,
      caseIds: cohortCases.map((c) => c.id),
    },
  });
}
