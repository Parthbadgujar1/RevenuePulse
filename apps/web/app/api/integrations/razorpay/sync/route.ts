/**
 * Sync real failed payments from the Razorpay REST API using stored API keys.
 * POST { limit?: number } -> fetches recent payments (status=failed), runs each
 * through the same pipeline as webhooks, returns counts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma, ensureDemoMerchant } from '@rp/database';
import { processJob, JobType } from '@rp/observability';import { normalizeRazorpayEvent } from '@rp/razorpay';
import { decryptSecret } from '../../../../../lib/crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function resolveCredentials() {
  // 1. Stored connection (secret AES-256-GCM encrypted at rest)
  const conn = await prisma.providerConnection.findFirst({
    where: { provider: 'razorpay', status: 'active' },
    orderBy: { id: 'desc' },
  });
  if (conn?.keySecretEncrypted && conn.keyId) {
    const secret = decryptSecret(conn.keySecretEncrypted);
    if (!secret) {
      return {
        error:
          'Stored Razorpay key secret could not be decrypted. Reconnect the integration.',
      };
    }
    return { keyId: conn.keyId, keySecret: secret };
  }
  // 2. Env fallback
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    return {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
    };
  }
  return {
    error:
      'No Razorpay API keys available. Connect with Key ID + Key Secret on /integrations (stored encrypted), or set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}) as any);
  const limit = Math.min(Math.max(parseInt(String(body?.limit ?? 100), 10) || 100, 1), 400);

  const creds = await resolveCredentials();
  if ('error' in creds && creds.error) {
    return NextResponse.json({ error: creds.error }, { status: 400 });
  }
  const { keyId, keySecret } = creds as { keyId: string; keySecret: string };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  let payments: any[];
  try {
    // Razorpay lists newest-first; fetch then filter failures client-side.
    const res = await fetch(`https://api.razorpay.com/v1/payments?count=${limit}`, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) {
      return NextResponse.json({ error: 'Razorpay rejected the credentials (401). Check Key ID / Key Secret.' }, { status: 401 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ error: `Razorpay API error ${res.status}: ${text.slice(0, 300)}` }, { status: 502 });
    }
    const json = await res.json();
    payments = Array.isArray(json.items) ? json.items : [];
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not reach api.razorpay.com: ${e?.message ?? 'network error'}` },
      { status: 502 },
    );
  }

  const merchantId = await ensureDemoMerchant(prisma);
  const cohortStart = new Date();
  let processed = 0;
  let pipelineErrors = 0;
  const perStatus: Record<string, number> = {};

  for (const p of payments) {
    perStatus[p.status] = (perStatus[p.status] ?? 0) + 1;
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
        providerEventId: `rzp_api_${p.id}_${Date.now()}`,
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
    pipelineErrors,
    casesCreated,
    actionsCreated,
  });
}
