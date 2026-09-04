import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireMerchantContext();
    const { id } = await params;

    const tx = await prisma.transaction.findFirst({
      where: { id, merchantId: ctx.merchantId },
      include: {
        revenueCases: {
          include: {
            refunds: { select: { id: true, amount: true, status: true, createdAt: true } },
          },
        },
      },
    });

    if (!tx) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found', details: {} } },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        id: tx.id,
        providerTransactionId: tx.providerTransactionId,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        paymentMethod: tx.paymentMethod,
        paymentMethodDetails: tx.paymentMethodDetails,
        failureCode: tx.failureCode,
        failureCategory: tx.failureCategory,
        failureMessage: tx.failureMessage,
        occurredAt: tx.occurredAt.toISOString(),
        createdAt: tx.createdAt.toISOString(),
        webhookEventId: tx.webhookEventId,
        rawEventRef: tx.rawEventRef,
        cases: tx.revenueCases.map((c) => ({
          id: c.id,
          ref: c.ref,
          status: c.status,
          amountAtRisk: c.amountAtRisk,
          priority: c.priority,
          createdAt: c.createdAt.toISOString(),
          refunds: c.refunds,
        })),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'TRANSACTION_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
