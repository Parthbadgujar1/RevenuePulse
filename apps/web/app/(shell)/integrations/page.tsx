// Integrations - Razorpay connection and webhook status
import ConnectRazorpayCard from '../../../components/connect-razorpay-card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Integrations — RevenuePulse' };

async function loadStatus() {
  try {
    const { prisma, ensureDemoMerchant } = await import('@rp/database');
    const merchantId = await ensureDemoMerchant(prisma);
    const conn = await prisma.providerConnection.findFirst({
      where: { merchantId, provider: 'razorpay' },
      orderBy: { id: 'desc' },
    });
    const [lastEvents, totalEvents] = await Promise.all([
      prisma.webhookEvent.findMany({
        where: { merchantId },
        orderBy: { receivedAt: 'desc' as const },
        take: 5,
      }),
      prisma.webhookEvent.count({ where: { merchantId } }),
    ]);
    return {
      connected: Boolean(conn && conn.status === 'active'),
      mode: 'demo',
      connectionMode: (conn as any)?.mode ?? null,
      displayName: (conn as any)?.displayName ?? null,
      connectedAt: (conn as any)?.createdAt?.toISOString() ?? null,
      listeningTo: [
        'payment.failed',
        'payment.authorized',
        'payment.captured',
        'refund.processed',
        'subscription.charged',
      ],
      lastEvent: lastEvents[0]
        ? { eventType: lastEvents[0].eventType, receivedAt: lastEvents[0].receivedAt.toISOString(), status: lastEvents[0].status }
        : null,
      recentEvents: lastEvents.map((e) => ({
        eventType: e.eventType,
        status: e.status,
        receivedAt: e.receivedAt.toISOString(),
      })),
      totalEvents,
    };
  } catch {
    return null;
  }
}

export default async function IntegrationsPage() {
  const status = await loadStatus();
  return (
    <div className="mx-auto max-w-5xl">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">Integrations</h1>
        <p className="mb-6 mt-1 text-sm text-slate-400">
          Connect a data source so failed payments flow into the AI recovery pipeline.
        </p>
        <ConnectRazorpayCard initial={status} />
      </div>
  );
}
