import { prisma } from '@rp/database';

async function main() {
  const cases = await prisma.revenueCase.findMany({
    select: { status: true, amountAtRisk: true, stoppedReason: true },
  });
  const byStatus: Record<string, { n: number; amount: number }> = {};
  for (const c of cases) {
    byStatus[c.status] ??= { n: 0, amount: 0 };
    byStatus[c.status].n++;
    byStatus[c.status].amount += c.amountAtRisk;
  }
  console.log('=== ALL CASES BY STATUS ===');
  for (const [s, v] of Object.entries(byStatus)) {
    console.log(`${s}: ${v.n} cases, Rs ${(v.amount / 100).toFixed(0)} at risk`);
  }
  const stops: Record<string, number> = {};
  for (const c of cases) if (c.stoppedReason) stops[c.stoppedReason] = (stops[c.stoppedReason] ?? 0) + 1;
  console.log('stoppedReasons:', JSON.stringify(stops));

  const outcomes = await prisma.outcome.groupBy({
    by: ['result'],
    _count: { id: true },
    _sum: { recoveredAmount: true },
  });
  console.log('outcomes:', JSON.stringify(outcomes));

  const preds = await prisma.prediction.aggregate({ _count: true });
  console.log('predictions:', preds._count);
  await prisma.$disconnect();
}
main();
