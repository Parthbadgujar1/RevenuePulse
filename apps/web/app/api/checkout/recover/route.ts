import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';

interface IncentiveChoice {
  type: string;
  value: unknown;
}

const INCENTIVE_TIERS: { maxAmount: number; incentive: IncentiveChoice }[] = [
  { maxAmount: 50000, incentive: { type: 'flat_discount', value: { flatDiscount: 200 } } },
  { maxAmount: 200000, incentive: { type: 'discount_pct', value: { discountPct: 5 } } },
  { maxAmount: Infinity, incentive: { type: 'discount_pct', value: { discountPct: 10 } } },
];

function selectIncentive(amount: number): IncentiveChoice {
  for (const tier of INCENTIVE_TIERS) {
    if (amount <= tier.maxAmount) return tier.incentive;
  }
  return INCENTIVE_TIERS[INCENTIVE_TIERS.length - 1].incentive;
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'checkout-recover', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== 'string') {
    return NextResponse.json({ error: 'Missing "sessionId"' }, { status: 400 });
  }

  const { sessionId, action, incentiveType, incentiveValue } = body as {
    sessionId: string;
    action?: string;
    incentiveType?: string;
    incentiveValue?: unknown;
  };

  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId, merchantId: ctx.merchantId },
  });
  if (!session) {
    return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 });
  }

  if (action === 'mark_recovered') {
    const updated = await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status: 'recovered', recoveredAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId, actorType: 'user', actorId: ctx.userId,
        action: 'checkout_marked_recovered', entityType: 'checkout_session',
        entityId: session.id, reason: 'Manually marked as recovered',
        beforeState: { status: session.status } as any,
        afterState: { status: 'recovered' } as any,
        createdAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true, sessionId: updated.id, status: updated.status });
  }

  if (session.status !== 'abandoned') {
    return NextResponse.json({ error: `Cannot recover session with status "${session.status}"` }, { status: 400 });
  }

  let chosenType: string;
  let chosenValue: unknown;

  if (incentiveType && incentiveValue !== undefined) {
    chosenType = incentiveType;
    chosenValue = incentiveValue;
  } else {
    const selected = selectIncentive(session.amount);
    chosenType = selected.type;
    chosenValue = selected.value;
  }

  const beforeState = { status: session.status, incentiveType: session.incentiveType } as any;

  const updated = await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      status: 'recovery_sent',
      recoveryChannel: 'email',
      incentiveType: chosenType,
      incentiveValue: chosenValue as any,
    },
  });

  await prisma.auditLog.create({
    data: {
      merchantId: ctx.merchantId,
      actorType: 'system',
      actorId: ctx.userId,
      action: 'checkout_recovery_sent',
      entityType: 'checkout_session',
      entityId: session.id,
      reason: `Recovery initiated with incentive ${chosenType}`,
      beforeState,
      afterState: { status: 'recovery_sent', incentiveType: chosenType } as any,
      createdAt: new Date(),
    },
  });

  return NextResponse.json({
    ok: true,
    sessionId: updated.id,
    status: updated.status,
    recoveryChannel: updated.recoveryChannel,
    incentiveType: chosenType,
    incentiveValue: chosenValue,
  });
}
