/**
 * Live outcome verification core.
 *
 * For every OUTCOME_PENDING case (live executions awaiting a provider
 * outcome), fetch the payment status from api.razorpay.com:
 *   captured            -> Outcome RECOVERED, verified with provider ref
 *   failed / cancelled  -> Outcome NOT_RECOVERED, honest failure recorded
 * anything else stays OUTCOME_PENDING.
 *
 * No outcome is ever fabricated — only what Razorpay itself reports is
 * recorded. Shared by POST /api/outcomes/verify (single merchant) and the
 * background poller started from instrumentation.ts (all merchants).
 */
import { prisma } from '@rp/database';
import { resolveRazorpayCredentials } from './razorpay-creds';

export interface VerifySummary {
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  merchants?: number;
  checked?: number;
  recovered?: number;
  notRecovered?: number;
  skipped?: string[];
}

export async function verifyPendingLiveOutcomes(
  opts: { merchantId?: string; limit?: number } = {}
): Promise<VerifySummary> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  // Merchants that actually have live outcomes waiting
  const groups = await prisma.revenueCase.groupBy({
    by: ['merchantId'],
    where: {
      status: 'OUTCOME_PENDING',
      ...(opts.merchantId ? { merchantId: opts.merchantId } : {}),
    },
    _count: { id: true },
  });
  if (groups.length === 0) {
    return { status: 'ok', checked: 0, recovered: 0, notRecovered: 0 };
  }

  let checked = 0;
  let recovered = 0;
  let notRecovered = 0;
  const skipped: string[] = [];

  for (const g of groups) {
    const creds = await resolveRazorpayCredentials(g.merchantId);
    if ('error' in creds) {
      skipped.push(`merchant ${g.merchantId}: ${creds.error}`);
      continue;
    }
    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');

    const pendingCases = await prisma.revenueCase.findMany({
      where: { merchantId: g.merchantId, status: 'OUTCOME_PENDING' },
      include: { transaction: { select: { id: true, providerTransactionId: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const c of pendingCases) {
      const actionId = c.currentActionId;
      if (!actionId || !c.transaction?.providerTransactionId) {
        skipped.push(c.ref ?? c.id);
        continue;
      }
      const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
      if (!action || action.executionStatus !== 'EXECUTED') {
        skipped.push(c.ref ?? c.id);
        continue;
      }
      // Only live executions may be resolved here; demo outcomes are drawn,
      // never polled.
      const execAudit = await prisma.auditLog.findFirst({
        where: {
          action: 'recovery_action_executed',
          entityType: 'recovery_action',
          entityId: action.id,
        },
        orderBy: { createdAt: 'desc' },
      });
      if ((execAudit?.evidence as any)?.mode !== 'PROVIDER_LIVE') {
        skipped.push(c.ref ?? c.id);
        continue;
      }

      // Fetch REAL payment status from Razorpay
      let payment: any;
      try {
        const res = await fetch(
          `https://api.razorpay.com/v1/payments/${c.transaction.providerTransactionId}`,
          { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10000) }
        );
        if (res.status === 401) {
          skipped.push(
            `merchant ${g.merchantId}: Razorpay rejected stored credentials (401)`
          );
          break;
        }
        if (!res.ok) {
          skipped.push(`${c.ref ?? c.id} (HTTP ${res.status})`);
          continue;
        }
        payment = await res.json();
      } catch (e: any) {
        skipped.push(`${c.ref ?? c.id} (${e?.message ?? 'network error'})`);
        continue;
      }

      checked++;
      const now = new Date();

      if (payment.status === 'captured') {
        const outcome = await prisma.outcome.create({
          data: {
            actionId: action.id,
            recoveredAmount: c.amountAtRisk,
            result: 'RECOVERED',
            recoveryTimestamp: now,
            measuredCost: action.expectedCost,
            verificationRef: String(payment.id),
            notes: `Verified via Razorpay API poll (status=captured)`,
            verifiedAt: now,
          },
        });
        await prisma.recoveryAction.update({
          where: { id: action.id },
          data: { outcomeId: outcome.id, completedAt: now },
        });
        await prisma.revenueCase.update({
          where: { id: c.id },
          data: { status: 'RECOVERED' },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: g.merchantId,
            actorType: 'system',
            actorId: 'outcome-verifier',
            action: 'recovery_outcome_verified',
            entityType: 'revenue_case',
            entityId: c.id,
            reason: `Provider reports captured — ₹${(c.amountAtRisk / 100).toLocaleString('en-IN')} recovered`,
            evidence: { verificationRef: payment.id, source: 'api-poll' },
            beforeState: { status: 'OUTCOME_PENDING' },
            afterState: { status: 'RECOVERED' },
            createdAt: now,
          },
        });
        recovered++;
      } else if (['failed', 'cancelled'].includes(String(payment.status))) {
        // Terminal failure per provider — record the honest negative outcome.
        const outcome = await prisma.outcome.create({
          data: {
            actionId: action.id,
            recoveredAmount: 0,
            result: 'NOT_RECOVERED',
            recoveryTimestamp: now,
            measuredCost: action.expectedCost,
            verificationRef: String(payment.id),
            notes: `Provider reports ${payment.status}: ${payment.error_description ?? 'no detail'}`,
            verifiedAt: now,
          },
        });
        await prisma.recoveryAction.update({
          where: { id: action.id },
          data: { outcomeId: outcome.id, completedAt: now },
        });
        await prisma.revenueCase.update({
          where: { id: c.id },
          data: { status: 'FAILED', stoppedReason: `provider_${payment.status}` },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: g.merchantId,
            actorType: 'system',
            actorId: 'outcome-verifier',
            action: 'recovery_outcome_verified',
            entityType: 'revenue_case',
            entityId: c.id,
            reason: `Provider reports ${payment.status} — recovery not achieved`,
            evidence: { verificationRef: payment.id, source: 'api-poll' },
            beforeState: { status: 'OUTCOME_PENDING' },
            afterState: { status: 'FAILED' },
            createdAt: now,
          },
        });
        notRecovered++;
      } else {
        // authorized / refunded / still processing — leave OUTCOME_PENDING untouched
        skipped.push(`${c.ref ?? c.id} (status=${payment.status})`);
        checked--;
      }
    }
  }

  return {
    status: 'ok',
    merchants: groups.length,
    checked,
    recovered,
    notRecovered,
    skipped: skipped.slice(0, 20),
  };
}
