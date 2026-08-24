import { NextResponse } from 'next/server';
import { verifyRazorpaySignature } from '@rp/providers';
import {
  prisma,
  ensureDemoMerchant,
  registerWebhookEvent,
  hashPayload,
} from '@rp/database';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { enqueueProcessingJob, JobType } from '@rp/observability';
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
  try {
    const body = await request.text();
    const signature = request.headers.get('x-razorpay-signature') || '';
    const eventId = request.headers.get('x-razorpay-event-id') || '';

    // 1. Verify webhook signature. In live mode, prefer the env secret but
    //    fall back to the secret stored on the active Razorpay connection
    //    (set when the merchant connected their keys in the dashboard).
    let verification = verifyRazorpaySignature(body, signature);
    if (!verification.valid && verification.mode === 'live') {
      const conn = await prisma.providerConnection.findFirst({
        where: { provider: 'razorpay', status: 'active' },
        orderBy: { id: 'desc' },
      });
      if (conn?.webhookSecret) {
        verification = verifyRazorpaySignature(body, signature, {
          secret: conn.webhookSecret,
        });
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

    const merchantId = await ensureDemoMerchant(prisma);

    // 3. Durable idempotency + persistence in one step.
    //    providerEventId falls back to a hash of the body when Razorpay
    //    does not supply an explicit event id header.
    const registration = await registerWebhookEvent(prisma, {
      providerEventId: eventId || `sha:${hashPayload(body)}`,
      eventType: eventData.event_type,
      rawBody: body,
      summary: {
        amount: eventData.data?.amount,
        currency: eventData.data?.currency,
        status: eventData.data?.status,
        errorCode: eventData.data?.error?.code ?? null,
      },
      merchantId,
    });

    if (registration.duplicate) {
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
