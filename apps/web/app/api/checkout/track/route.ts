import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'checkout-track', { limit: 60, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== 'string') {
    return NextResponse.json({ error: 'Missing "sessionId"' }, { status: 400 });
  }

  const { sessionId, customerEmail, customerPhone, amount, currency, items, abandonmentReason } = body as {
    sessionId: string;
    customerEmail?: string;
    customerPhone?: string;
    amount?: number;
    currency?: string;
    items?: unknown;
    abandonmentReason?: string;
  };

  if (typeof amount !== 'number' || amount <= 0) {
    return NextResponse.json({ error: '"amount" must be a positive number (paise)' }, { status: 400 });
  }

  const session = await prisma.checkoutSession.upsert({
    where: { sessionId },
    update: {
      customerEmail: customerEmail ?? undefined,
      customerPhone: customerPhone ?? undefined,
      amount: Math.round(amount),
      currency: currency ?? 'INR',
      items: (items as any) ?? undefined,
      status: 'abandoned',
      abandonmentReason: abandonmentReason ?? undefined,
    },
    create: {
      sessionId,
      merchantId: ctx.merchantId,
      customerEmail: customerEmail ?? null,
      customerPhone: customerPhone ?? null,
      amount: Math.round(amount),
      currency: currency ?? 'INR',
      items: (items as any) ?? undefined,
      status: 'abandoned',
      abandonmentReason: abandonmentReason ?? null,
      createdAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      merchantId: ctx.merchantId,
      actorType: 'system',
      actorId: ctx.userId,
      action: 'checkout_tracked',
      entityType: 'checkout_session',
      entityId: session.id,
      reason: 'Checkout abandonment tracked',
      afterState: { sessionId, status: 'abandoned' } as any,
      createdAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, sessionId: session.id, checkoutSessionId: sessionId });
}
