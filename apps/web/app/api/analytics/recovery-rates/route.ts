import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  const ctx = await requireMerchantContext();

  const period = req.nextUrl.searchParams.get('period') ?? '30d';
  const daysBack = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const cases = await prisma.revenueCase.findMany({
    where: {
      merchantId: ctx.merchantId,
      createdAt: { gte: cutoff },
    },
    include: {
      transaction: {
        select: { paymentMethod: true, failureCategory: true, amount: true },
      },
      refunds: {
        select: { amount: true, status: true },
      },
    },
    take: 2000,
  });

  const byMethod: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }> = {};
  const byCategory: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }> = {};

  let totalCases = 0;
  let totalRecovered = 0;
  let totalAmountAtRisk = 0;
  let totalRecoveredAmount = 0;

  for (const kase of cases) {
    const tx = kase.transaction;
    if (!tx) continue;

    const method = tx.paymentMethod ?? 'unknown';
    const category = tx.failureCategory ?? 'unknown';
    const isRecovered = kase.status === 'RECOVERED';
    const recoveredAmount = isRecovered ? kase.amountAtRisk : 0;

    totalCases++;
    totalAmountAtRisk += kase.amountAtRisk;
    if (isRecovered) {
      totalRecovered++;
      totalRecoveredAmount += recoveredAmount;
    }

    const init = (entry: { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }) => {
      entry.totalCases++;
      entry.totalAmountAtRisk += kase.amountAtRisk;
      if (isRecovered) {
        entry.recoveredCases++;
        entry.totalRecovered += recoveredAmount;
      }
    };

    if (!byMethod[method]) byMethod[method] = { totalCases: 0, recoveredCases: 0, totalAmountAtRisk: 0, totalRecovered: 0 };
    init(byMethod[method]);

    if (!byCategory[category]) byCategory[category] = { totalCases: 0, recoveredCases: 0, totalAmountAtRisk: 0, totalRecovered: 0 };
    init(byCategory[category]);
  }

  const toRate = (v: { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }) => ({
    ...v,
    recoveryRate: v.totalCases > 0 ? Math.round((v.recoveredCases / v.totalCases) * 10000) / 100 : 0,
  });

  return NextResponse.json({
    analytics: {
      overallRate: totalCases > 0 ? Math.round((totalRecovered / totalCases) * 10000) / 100 : 0,
      totalCases,
      totalRecovered,
      totalAmountAtRisk,
      totalRecoveredAmount,
      byPaymentMethod: Object.entries(byMethod).map(([method, data]) => ({
        method,
        ...toRate(data),
      })),
      byFailureCategory: Object.entries(byCategory).map(([category, data]) => ({
        category,
        ...toRate(data),
      })),
    },
  });
}
