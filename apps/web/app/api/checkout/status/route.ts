import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  const ctx = await requireMerchantContext();

  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing "sessionId" query parameter' }, { status: 400 });
  }

  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId, merchantId: ctx.merchantId },
  });
  if (!session) {
    return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: session.id,
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    recoveryChannel: session.recoveryChannel,
    incentiveType: session.incentiveType,
    incentiveValue: session.incentiveValue,
    recoveredAt: session.recoveredAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}
