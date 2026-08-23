import { NextResponse } from 'next/server';
import { verifyRazorpaySignature } from '@rp/providers';
import {
  tryAcquireIdempotencyKey,
  completeIdempotencyKey,
} from '@rp/database';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { enqueueProcessingJob, JobType } from '@rp/observability';
import type { NextRequest } from 'next/server';

/**
 * POST: Receive Razorpay webhook
 *
 * Flow:
 * 1. Verify webhook signature (simulation mode accepts unsigned demo events)
 * 2. Validate schema
 * 3. Check idempotency (prevent duplicate processing)
 * 4. Persist raw event metadata (minimal, safe)
 * 5. Normalize to internal event format
 * 6. Enqueue async processing job
 * 7. Acknowledge webhook safely
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-razorpay-signature') || '';
    const eventId = request.headers.get('x-razorpay-event-id') || '';

    // 1. Verify webhook signature
    const verification = verifyRazorpaySignature(body, signature);
    if (!verification.valid) {
      console.warn('Webhook signature verification failed');
      return new NextResponse('Invalid signature', { status: 400 });
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
    } catch (e) {
      return new NextResponse('Failed to parse JSON', { status: 400 });
    }

    // 3. Check idempotency - prevent duplicate processing
    let idempotencyKey: string | null = null;
    if (eventId) {
      idempotencyKey = `webhook_${eventId}`;
      const acquired = await tryAcquireIdempotencyKey(idempotencyKey, 3600);

      if (!acquired) {
        // Already processed this webhook - acknowledge safely
        return new NextResponse(
          JSON.stringify({ status: 'already_processed' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // 4. Persist raw-safe metadata (minimal, no sensitive payload)
    const eventRef = await persistEventMetadata(eventData, eventId);

    // 5. Normalize to internal event format
    const normalizedEvent = normalizeRazorpayEvent(eventData);

    // 6. Enqueue async processing job
    const jobId = await enqueueProcessingJob(
      {
        type: JobType.PROCESS_TRANSACTION_EVENT,
        payload: {
          event: normalizedEvent,
          eventRef,
          source: 'webhook',
          simulated: verification.simulated,
        },
        source: 'webhook',
        idempotencyKey: idempotencyKey || undefined,
      },
      { timeout: 300000 }
    );

    // Mark the event as fully accepted for processing
    if (idempotencyKey) {
      await completeIdempotencyKey(idempotencyKey);
    }

    // 7. Acknowledge webhook safely (return 200 immediately)
    return new NextResponse(
      JSON.stringify({
        status: 'accepted',
        jobId,
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

/**
 * Helper: Persist raw event metadata to database
 * Stores only safe, non-sensitive references
 */
async function persistEventMetadata(
  eventData: any,
  eventId?: string
): Promise<string> {
  // In production, this would use Prisma to store:
  // - event type
  // - merchant ID
  // - timestamps
  // - normalized references (NOT full payload)
  // - encrypted minimal metadata

  // For now, return a reference ID
  return `event_ref_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

