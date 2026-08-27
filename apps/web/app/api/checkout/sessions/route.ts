import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(_req: NextRequest) {
  const ctx = await requireMerchantContext();

  const sessions = await prisma.checkoutSession.findMany({
    where: { merchantId: ctx.merchantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      sessionId: s.sessionId,
      amount: s.amount,
      currency: s.currency,
      status: s.status,
      abandonmentReason: s.abandonmentReason,
      incentiveType: s.incentiveType,
      customerEmail: s.customerEmail,
      createdAt: s.createdAt,
    })),
    total: sessions.length,
  });
}
