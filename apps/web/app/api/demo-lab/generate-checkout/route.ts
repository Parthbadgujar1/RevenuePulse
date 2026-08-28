import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { csrfGuard } from '../../../../lib/csrf';

const REASONS = ['payment_failed', 'network_error', 'user_exit', 'expired_card', 'insufficient_funds'];
const CHANNELS = ['email', 'sms', 'whatsapp'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  try {
    const body = await req.json().catch(() => ({} as any));
    const count = Math.min(100, Math.max(5, Number(body?.count) || 20));
    const seed = Number(body?.seed) > 0 ? Math.floor(Number(body?.seed)) : 20260826;

    const { merchantId } = await requireMerchantContext();
    const rng = mulberry32(seed);
    const created = [];

    for (let i = 0; i < count; i++) {
      const sessionId = `cs_demo_${seed}_${i}`;
      const amount = Math.floor(rng() * 490000) + 10000;
      const reason = REASONS[Math.floor(rng() * REASONS.length)];
      const status = rng() < 0.3 ? 'recovered' : rng() < 0.6 ? 'recovery_sent' : 'abandoned';

      const existing = await prisma.checkoutSession.findFirst({ where: { sessionId } });
      if (existing) continue;

      const session = await prisma.checkoutSession.create({
        data: {
          merchantId,
          sessionId,
          amount,
          currency: 'INR',
          abandonmentReason: reason,
          status,
          customerEmail: `customer${i}@example.com`,
          recoveryChannel: status !== 'abandoned' ? CHANNELS[Math.floor(rng() * CHANNELS.length)] : null,
          incentiveType: status !== 'abandoned' ? (rng() < 0.5 ? 'flat_discount' : 'discount_pct') : null,
          incentiveValue: status !== 'abandoned' ? { flatDiscount: 200 } : undefined,
          recoveredAt: status === 'recovered' ? new Date() : null,
          createdAt: new Date(),
        },
      });
      created.push({ id: session.id, sessionId, amount, status });
    }

    return NextResponse.json({
      ok: true,
      created: created.length,
      sessions: created,
      note: `Generated ${created.length} checkout sessions.`,
    });
  } catch (err: any) {
    console.error('[demo-generate-checkout]', err);
    return NextResponse.json({ ok: false, error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}
