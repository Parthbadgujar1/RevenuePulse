/**
 * Sweep OUTCOME_PENDING cases stuck beyond the allowed verification window.
 *
 * When a provider event or API poll never arrives (webhook dropped, merchant
 * disconnected, etc.), the case must not remain in limbo. After
 * RP_OUTCOME_TIMEOUT_DAYS (default 7) we mark it FAILED with an honest
 * stoppedReason and emit an audit record so the dashboard counts it correctly.
 */
import { prisma } from '@rp/database';

export async function sweepStalePendingCases(timeoutDays: number): Promise<number> {
  const deadline = new Date(Date.now() - timeoutDays * 86_400_000);

  const stale = await prisma.revenueCase.findMany({
    where: {
      status: 'OUTCOME_PENDING',
      createdAt: { lt: deadline },
    },
    select: { id: true, merchantId: true, amountAtRisk: true, ref: true },
  });

  if (stale.length === 0) return 0;

  // Batch update; emit an audit log per case for dashboard traceability.
  await prisma.$transaction([
    prisma.revenueCase.updateMany({
      where: { id: { in: stale.map((c) => c.id) } },
      data: { status: 'FAILED', stoppedReason: 'verification_timeout' },
    }),
    ...stale.map((c) =>
      prisma.auditLog.create({
        data: {
          merchantId: c.merchantId,
          actorType: 'system',
          actorId: 'outcome-poller',
          action: 'outcome_verification_timeout',
          entityType: 'revenue_case',
          entityId: c.id,
          reason: `No provider result within ${timeoutDays} days — marking verification_timeout`,
          evidence: {
            amountAtRisk: c.amountAtRisk,
            verificationWindowDays: timeoutDays,
          } as any,
          beforeState: { status: 'OUTCOME_PENDING' } as any,
          afterState: { status: 'FAILED', stoppedReason: 'verification_timeout' } as any,
          createdAt: new Date(),
        },
      })
    ),
  ]);

  return stale.length;
}
