import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { getSummary } from '../../../../lib/dashboard-metrics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from') ? new Date(sp.get('from') as string) : undefined;
    const to = sp.get('to') ? new Date(sp.get('to') as string) : undefined;

    const summary = await getSummary(ctx.merchantId, { from, to });
    const merchant = await prisma.merchant.findUnique({
      where: { id: ctx.merchantId },
      select: { id: true, name: true },
    });

    return NextResponse.json({
      success: true,
      data: { ...summary, merchant: { id: merchant?.id, name: merchant?.name } },
      range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'SUMMARY_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
