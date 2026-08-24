/**
 * Razorpay integration status/connect/disconnect/test.
 * GET  -> connection state + last webhook events
 * POST -> { action: 'connect'|'disconnect'|'test', keyId?, keySecret?, live? }
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma, ensureDemoMerchant } from '@rp/database';
import { getProviderMode } from '@rp/providers';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { encryptSecret } from '../../../../lib/crypto';

async function getConnection(merchantId: string) {
  return prisma.providerConnection.findFirst({
    where: { merchantId, provider: 'razorpay' },
    orderBy: { id: 'desc' },
  });
}

/**
 * Probe the real Razorpay API with the provided credentials before saving
 * them. "Connected" therefore means the key pair actually works.
 */
async function validateCredentials(keyId: string, keySecret: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, error: 'Razorpay rejected these credentials (401 Unauthorized). Check Key ID and Key Secret.' };
    if (!res.ok) return { ok: false, error: `Razorpay API returned ${res.status}. Verify the keys and network access.` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Could not reach api.razorpay.com: ${e?.message ?? 'network error'}` };
  }
}

function masked(keyId?: string | null): string | null {
  if (!keyId) return null;
  if (keyId.length <= 12) return `${keyId.slice(0, 8)}****`;
  return `${keyId.slice(0, 11)}****${keyId.slice(-4)}`;
}

export async function GET() {
  const { merchantId } = await requireMerchantContext();
  const conn = await getConnection(merchantId);
  const [lastEvents, eventCount] = await Promise.all([
    prisma.webhookEvent.findMany({
      where: { merchantId },
      orderBy: { receivedAt: 'desc' as const },
      take: 5,
      select: { eventType: true, status: true, receivedAt: true },
    }),
    prisma.webhookEvent.count({ where: { merchantId } }),
  ]);

  return NextResponse.json({
    connected: Boolean(conn && conn.status === 'active'),
    mode: getProviderMode(),
    connectionMode: (conn as any)?.mode ?? null,
    displayName: (conn as any)?.displayName ?? null,
    connectedAt: (conn as any)?.createdAt ?? null,
    listeningTo: [
      'payment.failed',
      'payment.authorized',
      'payment.captured',
      'refund.processed',
      'subscription.charged',
    ],
    lastEvent: lastEvents[0] ?? null,
    recentEvents: lastEvents,
    totalEvents: eventCount,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || '');
  const { merchantId } = await requireMerchantContext();

  if (action === 'disconnect') {
    await prisma.providerConnection.deleteMany({ where: { merchantId, provider: 'razorpay' } });
    return NextResponse.json({ ok: true, disconnected: true });
  }

  if (action === 'test') {
    const t0 = Date.now();
      const [conn, last] = await Promise.all([
        getConnection(merchantId),
        prisma.webhookEvent.findFirst({ orderBy: { receivedAt: 'desc' as const } }),
      ]);
      return NextResponse.json({
        ok: true,
        latencyMs: Date.now() - t0,
        connected: Boolean(conn && conn.status === 'active'),
        lastEvent: last ? { eventType: last.eventType, createdAt: last.receivedAt } : null,
      });
  }

  if (action === 'connect') {
    const live = Boolean(body?.live);
    const keyId = String(body?.keyId || '').trim();
    const keySecret = String(body?.keySecret || '').trim();

    let mode = 'test_demo';
    let displayName: string;

    if (live) {
      if (!keyId || !keySecret) {
        return NextResponse.json(
          { error: 'Key ID and Key Secret are required for a live connection' },
          { status: 400 }
        );
      }
      // Prove the credentials actually work before saving them.
      const probe = await validateCredentials(keyId, keySecret);
      if (!probe.ok) {
        return NextResponse.json({ error: probe.error }, { status: 400 });
      }
      mode = 'live';
      displayName = masked(keyId)!;
    } else if (keySecret && keyId) {
      // Test-mode connection with real keys — validate them too so API sync works.
      const probe = await validateCredentials(keyId, keySecret);
      if (!probe.ok) {
        return NextResponse.json({ error: probe.error }, { status: 400 });
      }
      displayName = masked(keyId)!;
    } else {
      // Demo/test-mode connection without keys: simulated identity.
      displayName = keyId
        ? masked(keyId)!
        : `rzp_test_${crypto.randomBytes(4).toString('hex')}`;
    }

    const webhookSecret = crypto.randomBytes(24).toString('hex');
    await prisma.providerConnection.deleteMany({ where: { merchantId, provider: 'razorpay' } });
    const conn = await prisma.providerConnection.create({
      data: {
        merchantId,
        provider: 'razorpay',
        status: 'active',
        mode,
        displayName,
        keyId: keyId || null,
        credentialsRef: live ? `vault:${displayName}` : keySecret ? `vault:${displayName}` : null,
        keySecretEncrypted: keySecret ? encryptSecret(keySecret) : null,
        webhookSecret,
        createdAt: new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      connected: true,
      mode: (conn as any).mode,
      displayName: (conn as any).displayName,
      // Configure this in the Razorpay Dashboard -> Webhooks so live
      // payment.failed events are HMAC-verified end to end.
      webhookSecret: (conn as any).webhookSecret,
      webhookUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/webhooks/razorpay`,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
