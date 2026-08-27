import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  const ctx = await requireMerchantContext();

  const now = new Date();

  const invoices = await prisma.invoice.findMany({
    where: { merchantId: ctx.merchantId },
    orderBy: { dueDate: 'desc' },
  });

  const byAgingBucket: Record<string, { count: number; totalAmount: number }> = {};
  let totalPending = 0;
  let totalOverdue = 0;
  let overdueDaysSum = 0;
  let overdueCount = 0;

  for (const inv of invoices) {
    if (inv.status === 'paid' || inv.status === 'written_off') continue;
    const remaining = inv.amount - inv.amountPaid;

    if (inv.overdueDays > 0) {
      totalOverdue += remaining;
      overdueDaysSum += inv.overdueDays;
      overdueCount++;
    } else {
      totalPending += remaining;
    }

    const bucket = inv.agingBucket ?? 'current';
    if (!byAgingBucket[bucket]) byAgingBucket[bucket] = { count: 0, totalAmount: 0 };
    byAgingBucket[bucket].count++;
    byAgingBucket[bucket].totalAmount += remaining;
  }

  const totalInvoiced = invoices.reduce((s, i) => s + i.amount, 0);
  const totalPaid = invoices.reduce((s, i) => s + i.amountPaid, 0);
  const collectionRate = totalInvoiced > 0 ? totalPaid / totalInvoiced : 0;

  const recentChases = await prisma.auditLog.findMany({
    where: {
      merchantId: ctx.merchantId,
      action: 'invoice_chased',
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      entityId: true,
      reason: true,
      evidence: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    summary: {
      totalPending,
      totalOverdue,
      collectionRate: Math.round(collectionRate * 10000) / 100,
      agingBuckets: Object.entries(byAgingBucket).map(([label, data]) => ({
        label,
        count: data.count,
        amount: data.totalAmount,
      })),
      recentInvoices: invoices.slice(0, 10).map((inv) => ({
        id: inv.id,
        reference: inv.invoiceNumber,
        customerName: inv.customerName,
        amount: inv.amount,
        status: inv.status,
        overdueDays: inv.overdueDays,
        dueDate: inv.dueDate.toISOString(),
      })),
      recentChases,
    },
  });
}
