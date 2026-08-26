import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  const ctx = await requireMerchantContext();

  const groupBy = req.nextUrl.searchParams.get('groupBy') ?? 'method';

  const cases = await prisma.revenueCase.findMany({
    where: { merchantId: ctx.merchantId },
    include: {
      transaction: {
        select: { paymentMethod: true, failureCategory: true, amount: true },
      },
      refunds: {
        select: { amount: true, status: true },
      },
    },
    take: 1000,
  });

  const byMethod: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }> = {};
  const byCategory: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }> = {};
  const byPeriod: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }> = {};

  for (const kase of cases) {
    const tx = kase.transaction;
    if (!tx) continue;

    const method = tx.paymentMethod ?? 'unknown';
    const category = tx.failureCategory ?? 'unknown';
    const period = kase.createdAt.toISOString().slice(0, 7);
    const isRecovered = kase.status === 'RECOVERED';
    const recoveredAmount = isRecovered ? kase.amountAtRisk : 0;

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

    if (!byPeriod[period]) byPeriod[period] = { totalCases: 0, recoveredCases: 0, totalAmountAtRisk: 0, totalRecovered: 0 };
    init(byPeriod[period]);
  }

  const addRates = (group: Record<string, { totalCases: number; recoveredCases: number; totalAmountAtRisk: number; totalRecovered: number }>) => {
    for (const [, v] of Object.entries(group)) {
      (v as any).recoveryRate = v.totalCases > 0 ? Math.round((v.recoveredCases / v.totalCases) * 10000) / 100 : 0;
    }
  };

  addRates(byMethod);
  addRates(byCategory);
  addRates(byPeriod);

  return NextResponse.json({ groupBy, byMethod, byCategory, byPeriod });
}
