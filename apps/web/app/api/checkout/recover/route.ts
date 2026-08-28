import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { DEFAULT_MERCHANT_POLICY } from '@rp/policies';
import type { MerchantPolicy } from '@rp/policies';
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

/**
 * Enforce the merchant's policy hard limits on any checkout-recovery incentive.
 * The amount (in paise) a discount can grant is bounded by BOTH
 * maximumIncentivePercentage and maximumIncentiveAmount — whichever is lower
 * wins. Client-supplied incentives are never taken at face value: the chosen
 * incentive is recomputed and clamped server-side, so a malicious request
 * cannot grant itself a 100% discount.
 */
function clampIncentiveToPolicy(
  amount: number,
  chosen: IncentiveChoice,
  policy: MerchantPolicy
): IncentiveChoice {
  const pctCap = (policy.maximumIncentivePercentage / 100) * amount;
  const cap = Math.min(policy.maximumIncentiveAmount, pctCap);

  if (chosen.type === 'flat_discount') {
    const flat = Number((chosen.value as { flatDiscount?: number })?.flatDiscount ?? 0);
    return { type: 'flat_discount', value: { flatDiscount: Math.max(0, Math.min(flat, cap)) } };
  }

  if (chosen.type === 'discount_pct') {
    const pct = Number((chosen.value as { discountPct?: number })?.discountPct ?? 0);
    // Bounded both by the raw percentage and by the derived rupee cap so a
    // huge percentage never exceeds maximumIncentiveAmount.
    const allowedPct = Math.min(Math.max(0, pct), policy.maximumIncentivePercentage);
    const allowedByAmount = cap / amount; // maximum fraction the rupee cap allows
    return {
      type: 'discount_pct',
      value: { discountPct: Math.round(Math.min(allowedPct, allowedByAmount) * 1000) / 1000 },
    };
  }

  return chosen;
}

async function loadPolicy(merchantId: string): Promise<MerchantPolicy> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  const stored = ((merchant?.settings as Record<string, unknown>) ?? {}).recoveryPolicy as
    | Partial<MerchantPolicy>
    | undefined;
  return { ...DEFAULT_MERCHANT_POLICY, ...(stored ?? {}) };
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

  const { sessionId, action } = body as {
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

  // The incentive is ALWAYS chosen server-side and clamped to the merchant
  // policy's hard limits (maximumIncentivePercentage / maximumIncentiveAmount).
  // Client-supplied incentiveType/incentiveValue are intentionally ignored —
  // trusting them would let a request grant arbitrary discounts.
  const policy = await loadPolicy(ctx.merchantId);
  const base = selectIncentive(session.amount);
  const chosen = clampIncentiveToPolicy(session.amount, base, policy);
  const chosenType = chosen.type;
  const chosenValue = chosen.value;

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
