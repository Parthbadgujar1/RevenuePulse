/**
 * Sync real failed payments from the Razorpay REST API using stored API keys.
 * POST { limit?: number } -> fetches recent payments (status=failed), runs each
 * through the same pipeline as webhooks, returns counts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { processJob, JobType } from '@rp/observability';
import { normalizeRazorpayEvent } from '@rp/razorpay';
import { resolveRazorpayCredentials } from '../../../../../lib/razorpay-creds';
import { requireMerchantContext } from '../../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit';
import { csrfGuard } from '../../../../../lib/csrf';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  try {
    const { merchantId } = await requireMerchantContext();
    // Razorpay API quota is shared across the merchant's integration.
    const rl = checkRateLimit(req, 'sync', { limit: 10, windowMs: 60_000 }, merchantId);
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await req.json().catch(() => ({}) as any);
    const limit = Math.min(Math.max(parseInt(String(body?.limit ?? 100), 10) || 100, 1), 400);

    const creds = await resolveRazorpayCredentials(merchantId);
  if ('error' in creds) {
    return NextResponse.json({ error: creds.error }, { status: 400 });
  }
  const { keyId, keySecret } = creds;

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  let payments: any[];
  try {
    // Razorpay's list endpoint has no server-side status filter, so paginate
    // (newest-first) and stop as soon as the requested number of failures is
    // collected or the feed is exhausted. Hard per-request timeout keeps a
    // slow api.razorpay.com from hanging the route.
    payments = [];
    const pageSize = 100;
    const maxPages = 5;
    let exhausted = false;
    for (let page = 0; page < maxPages && !exhausted && payments.length < limit; page++) {
      const res = await fetch(
        `https://api.razorpay.com/v1/payments?count=${pageSize}&skip=${page * pageSize}`,
        {
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
        }
      );
      if (res.status === 401) {
        return NextResponse.json({ error: 'Razorpay rejected the credentials (401). Check Key ID / Key Secret.' }, { status: 401 });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return NextResponse.json({ error: `Razorpay API error ${res.status}: ${text.slice(0, 300)}` }, { status: 502 });
      }
      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      payments.push(...items.filter((p: any) => p.status === 'failed' || p.status === 'cancelled'));
      if (items.length < pageSize) exhausted = true;
    }
    payments = payments.slice(0, limit);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not reach api.razorpay.com: ${e?.message ?? 'network error'}` },
      { status: 502 },
    );
  }

  const cohortStart = new Date();
  let processed = 0;
  let pipelineErrors = 0;
  let duplicatesSkipped = 0;
  const perStatus: Record<string, number> = {};

  for (const p of payments) {
    perStatus[p.status] = (perStatus[p.status] ?? 0) + 1;
    // Stable idempotency key: syncing the same payment twice is a no-op.
    const providerEventId = `razorpay-api:${p.id}`;
    const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
    if (existing) {
      duplicatesSkipped++;
      continue;
    }
    const rawEvent = {
      event: p.status === 'failed' || p.status === 'cancelled' ? 'payment_failed' : `payment_${p.status}`,
      data: {
        id: p.id,
        amount: typeof p.amount === 'number' ? p.amount : Math.round((p.amount ?? 0)),
        currency: p.currency ?? 'INR',
        status: p.status,
        method: p.method ?? 'unknown',
        error: p.error_code
          ? { code: p.error_code, description: p.error_description }
          : undefined,
        time_created: p.created_at ? new Date(p.created_at * 1000).toISOString() : new Date().toISOString(),
        email: p.email ?? undefined,
        contact: p.contact ?? undefined,
      },
    };
    const normalized = normalizeRazorpayEvent(rawEvent as any);
    const webhookRow = await prisma.webhookEvent.create({
      data: {
        providerEventId,
        eventType: normalized.eventType,
        payloadHash: `sha:${p.id}`,
        status: 'RECEIVED',
        merchantId,
      },
    });
    const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
      event: normalized,
      eventRef: webhookRow.id,
      webhookEventId: webhookRow.id,
      source: 'razorpay-api',
      simulated: false,
    });
    if (result.success) processed++;
    else pipelineErrors++;
  }

  const [casesCreated, actionsCreated] = await Promise.all([
    prisma.revenueCase.count({ where: { createdAt: { gte: cohortStart } } }),
    prisma.recoveryAction.count({ where: { createdAt: { gte: cohortStart } } }),
  ]);
  await prisma.providerConnection.updateMany({
    where: { merchantId, provider: 'razorpay' },
    data: { lastSyncAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    fetched: payments.length,
    byStatus: perStatus,
    processed,
    duplicatesSkipped,
    pipelineErrors,
    casesCreated,
    actionsCreated,
  });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Sync failed' },
      { status: 500 }
    );
  }
}
