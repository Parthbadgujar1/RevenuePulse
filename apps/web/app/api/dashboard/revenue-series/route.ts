import { NextRequest, NextResponse } from 'next/server';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { getRevenueSeries } from '../../../../lib/dashboard-metrics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from') ? new Date(sp.get('from') as string) : undefined;
    const to = sp.get('to') ? new Date(sp.get('to') as string) : undefined;
    const days = Math.min(90, Math.max(1, Number.parseInt(sp.get('days') ?? '30', 10) || 30));
    const tz = sp.get('tz') || 'Asia/Kolkata';

    const series = await getRevenueSeries(ctx.merchantId, tz, days, { from, to });
    return NextResponse.json({ success: true, data: series });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'SERIES_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
