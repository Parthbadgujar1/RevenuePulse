/**
 * Verify pending LIVE recovery outcomes against the real Razorpay API.
 * POST /api/outcomes/verify
 *
 * Thin HTTP wrapper over verifyPendingLiveOutcomes() (shared with the
 * background poller in instrumentation.ts). Complements webhook-driven
 * resolution for setups without webhooks configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyPendingLiveOutcomes, VerifySummary } from '../../../../lib/outcome-verifier';
import { requireMerchantContext, apiErrorStatus } from '../../../../lib/merchant-context';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const summary: VerifySummary = await verifyPendingLiveOutcomes({
      merchantId: ctx.merchantId,
    });
    if (summary.status === 'error') {
      return NextResponse.json({ error: summary.reason }, { status: 502 });
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e: any) {
    console.error('[outcomes/verify] error:', e);
    return NextResponse.json(
      { error: e?.message ?? 'Verification failed' },
      { status: apiErrorStatus(e) }
    );
  }
}
