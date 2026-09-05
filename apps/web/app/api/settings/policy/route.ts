/**
 * Merchant recovery-policy settings.
 * GET  -> current effective policy (defaults merged with stored overrides)
 * PUT  -> validate + persist overrides under Merchant.settings.recoveryPolicy
 *
 * Stored policy is read by getMerchantPolicy() in the pipeline, so changes
 * apply to every new decision immediately — no redeploy needed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { DEFAULT_MERCHANT_POLICY } from '@rp/policies';
import type { MerchantPolicy } from '@rp/policies';
import { requireMerchantContext, requirePermission, apiErrorStatus } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';
import { sanitizePolicy } from './sanitize';

export async function GET() {
  try {
    const { merchantId } = await requireMerchantContext();
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    const stored = ((merchant?.settings as Record<string, unknown>) ?? {}).recoveryPolicy as
      | Partial<MerchantPolicy>
      | undefined;
    return NextResponse.json({
      policy: { ...DEFAULT_MERCHANT_POLICY, ...(stored ?? {}) },
      defaults: DEFAULT_MERCHANT_POLICY,
      hasOverrides: Boolean(stored),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Failed to load policy' },
      { status: apiErrorStatus(e) }
    );
  }
}

export async function PUT(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  try {
    const ctx = await requireMerchantContext();
    requirePermission(ctx, 'policies:configure');
    const rl = checkRateLimit(req, 'policy', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Expected a JSON policy object' }, { status: 400 });
    }
    const { policy, errors } = sanitizePolicy(body);
    if (errors.length) {
      return NextResponse.json({ error: 'Invalid policy', details: errors }, { status: 422 });
    }

    const merchant = await prisma.merchant.findUnique({ where: { id: ctx.merchantId } });
    const settings = ((merchant?.settings as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const updatedSettings = { ...settings, recoveryPolicy: policy };

    await prisma.merchant.update({
      where: { id: ctx.merchantId },
      data: { settings: updatedSettings },
    });

    return NextResponse.json({
      ok: true,
      saved: policy,
      effectivePolicy: { ...DEFAULT_MERCHANT_POLICY, ...policy },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Failed to save policy' },
      { status: apiErrorStatus(e) }
    );
  }
}
