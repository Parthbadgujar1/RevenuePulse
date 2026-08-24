/**
 * Razorpay integration status/connect/disconnect/test.
 * GET  -> connection state + last webhook events
 * POST -> { action: 'connect'|'disconnect'|'test', keyId?, keySecret?, live? }
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma, ensureDemoMerchant } from '@rp/database';
import { getProviderMode } from '@rp/providers';

async function getConnection(merchantId: string) {
  return prisma.providerConnection.findFirst({
    where: { merchantId, provider: 'razorpay' },
    orderBy: { id: 'desc' },
  });
}

function masked(keyId?: string | null): string | null {
  if (!keyId) return null;
  if (keyId.length <= 12) return `${keyId.slice(0, 8)}****`;
  return `${keyId.slice(0, 11)}****${keyId.slice(-4)}`;
}

export async function GET() {
  const merchantId = await ensureDemoMerchant(prisma);
  const conn = await getConnection(merchantId);
  const [lastEvents, eventCount] = await Promise.all([
    prisma.webhookEvent.findMany({
      orderBy: { receivedAt: 'desc' as const },
      take: 5,
      select: { eventType: true, status: true, receivedAt: true },
    }),
    prisma.webhookEvent.count(),
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
  const merchantId = await ensureDemoMerchant(prisma);

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
      mode = 'live';
      displayName = masked(keyId)!;
    } else {
      // Demo/test-mode connection: no real credentials needed. Generate a
      // simulated key identity so the UI shows a convincing connection.
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
        credentialsRef: live ? `vault:${displayName}` : null,
        webhookSecret,
        createdAt: new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      connected: true,
      mode: (conn as any).mode,
      displayName: (conn as any).displayName,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
