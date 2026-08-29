import { prisma } from '@rp/database';
import { withMerchantContext } from '../../../../lib/merchant-context';

/**
 * Recent activity from the real AuditLog trail.
 * The bell in the app shell reads this; counts double as "unread since last
 * opened" client-side. Honest source: every pipeline/user action is logged
 * here (failure_diagnosed, recovery_decision_made, recovery_action_executed,
 * recovery_outcome_verified, invoice_chased, promise_created, …).
 */
export const GET = withMerchantContext(async (ctx) => {
  const logs = await prisma.auditLog.findMany({
    where: { merchantId: ctx.merchantId },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      action: true,
      actorType: true,
      entityType: true,
      entityId: true,
      reason: true,
      createdAt: true,
    },
  });

  return {
    items: logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    })),
    unread: logs.filter(
      (l) => Date.now() - l.createdAt.getTime() < 24 * 60 * 60 * 1000,
    ).length,
  };
});