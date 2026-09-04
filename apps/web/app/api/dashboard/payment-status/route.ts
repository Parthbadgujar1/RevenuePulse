import { NextRequest, NextResponse } from 'next/server';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { getPaymentStatus } from '../../../../lib/dashboard-metrics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from') ? new Date(sp.get('from') as string) : undefined;
    const to = sp.get('to') ? new Date(sp.get('to') as string) : undefined;

    const data = await getPaymentStatus(ctx.merchantId, { from, to });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'PAYMENT_STATUS_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
