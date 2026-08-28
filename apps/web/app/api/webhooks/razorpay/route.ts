import { NextResponse } from 'next/server';
import { verifyRazorpaySignature } from '@rp/providers';
import {
  prisma,
  ensureDemoMerchant,
  registerWebhookEvent,
  hashPayload,
} from '@rp/database';
import { decryptSecret } from '../../../../lib/crypto';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { enqueueProcessingJob, JobType, incWebhookEvent } from '@rp/observability';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import type { NextRequest } from 'next/server';

/**
 * POST: Receive Razorpay webhook
 *
 * Flow:
 * 1. Verify webhook signature (DEMO_MODE accepts unsigned demo events)
 * 2. Validate schema
 * 3. Durable idempotency: WebhookEvent row owns the state machine
 *    (RECEIVED -> PROCESSING -> PROCESSED | FAILED). Duplicate provider
 *    event ids are acknowledged without reprocessing.
 * 4. Enqueue async processing job - completion is recorded by the worker
 *    only after the workflow succeeds.
 */
export async function POST(request: NextRequest) {
  // Flood control: generous ceiling for legitimate provider retries.
  const rl = checkRateLimit(request, 'webhook', { limit: 100, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const body = await request.text();
    const signature = request.headers.get('x-razorpay-signature') || '';
    const eventId = request.headers.get('x-razorpay-event-id') || '';

    // 1. Verify webhook signature. In live mode, prefer the env secret but
    //    fall back to stored per-merchant connection secrets: try EVERY
    //    active Razorpay connection until one validates, so multi-tenant
    //    attribution is by matching secret rather than "latest row wins".
    let verification = verifyRazorpaySignature(body, signature);
    let conn: { merchantId: string; webhookSecret: string | null } | null = null;
    if (!verification.valid && verification.mode === 'live') {
      const connections = await prisma.providerConnection.findMany({
        where: { provider: 'razorpay', status: 'active' },
        select: { merchantId: true, webhookSecret: true, webhookSecretEncrypted: true },
      });
      for (const candidate of connections) {
        // Prefer the AES-256-GCM encrypted secret; fall back to the legacy
        // plaintext column for connections created before encryption.
        const secret = decryptSecret(candidate.webhookSecretEncrypted ?? '') ??
          candidate.webhookSecret;
        if (!secret) continue;
        const attempt = verifyRazorpaySignature(body, signature, {
          secret,
        });
        if (attempt.valid) {
          verification = attempt;
          conn = { merchantId: candidate.merchantId, webhookSecret: secret };
          break;
        }
      }
    }
    if (!verification.valid) {
      console.warn('Webhook signature verification failed');
      return new NextResponse('Invalid signature', { status: 401 });
    }

    // 2. Validate schema - check required fields
    let eventData: any;
    try {
      eventData = JSON.parse(body);
      if (!eventData.event_type && !eventData.event) {
        return new NextResponse('Invalid event schema', { status: 400 });
      }
      if (!eventData.data) {
        return new NextResponse('Invalid event schema', { status: 400 });
      }
      // Accept both `event_type` (simulation) and `event` (Razorpay actual)
      eventData.event_type = eventData.event_type || eventData.event;
    } catch {
      return new NextResponse('Failed to parse JSON', { status: 400 });
    }

    // Merchant attribution: a signed live webhook belongs to the merchant
    // whose connection carries the matching secret; demo events land on the
    // seeded demo tenant.
    const merchantId =
      conn?.merchantId ?? (await ensureDemoMerchant(prisma));

    // Nested entity for summaries (real webhooks use data.<resource>.entity)
    const entity =
      eventData.data?.payment?.entity ??
      eventData.data?.subscription?.entity ??
      eventData.data?.refund?.entity ??
      eventData.data ?? {};

    // 3. Durable idempotency + persistence in one step.
    //    providerEventId falls back to provider payment id, then body hash.
    const registration = await registerWebhookEvent(prisma, {
      providerEventId:
        eventId || (entity.id ? `evt:${entity.id}:${eventData.event_type}` : `sha:${hashPayload(body)}`),
      eventType: eventData.event_type,
      rawBody: body,
      summary: {
        amount: entity.amount,
        currency: entity.currency,
        status: entity.status,
        errorCode: entity.error_code ?? entity.error?.code ?? null,
      },
      merchantId,
    });

    if (registration.duplicate) {
      incWebhookEvent('duplicate', eventData.event_type);
      return new NextResponse(
        JSON.stringify({ status: 'already_processed' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Normalize to internal event format
    const normalizedEvent = normalizeRazorpayEvent(eventData);

    // 5. Enqueue async processing job (worker records completion)
    const jobId = await enqueueProcessingJob(
      {
        type: JobType.PROCESS_TRANSACTION_EVENT,
        payload: {
          merchantId,
          event: normalizedEvent,
          eventRef: registration.id,
          webhookEventId: registration.id,
          source: 'webhook',
          simulated: verification.simulated,
        },
        source: 'webhook',
      },
      { timeout: 300000 }
    );

    // 6. Acknowledge webhook safely (return 200 immediately)
    incWebhookEvent('accepted', eventData.event_type);
    return new NextResponse(
      JSON.stringify({
        status: 'accepted',
        jobId,
        eventId: registration.id,
        simulated: verification.simulated,
        message: 'Webhook accepted for processing',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Return 200 to avoid Razorpay retry storms; job system handles retries
    return new NextResponse(
      JSON.stringify({ status: 'error', error: 'Webhook processing error' }),
      { status: 200 }
    );
  }
}

/**
 * GET: Health check for webhook endpoint
 */
export async function GET() {
  return new NextResponse(
    JSON.stringify({ status: 'ok', message: 'Webhook endpoint active' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
