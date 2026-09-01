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

// Fetch the REAL set of payments correlated to this recovery action.
//
// Correlation layer (fixes the P0 "verifier checks the wrong object" bug):
//   RecoveryAction.providerActionId = payment link id (plink_xxx)
//   -> Razorpay Payment Link
//      -> payments made against that link (pay_yyy)
//
// When the live action created a Payment Link, we ask Razorpay for that
// LINK's payments and resolve the case from THOSE — never from the original
// failed payment (pay_xxx), which is a different provider object. We only
// fall back to the original transaction id when the action had no payment
// link (a recorded-only live action).
type CorrelatedPayment =
  | { payments: any[]; source: 'payment-link' | 'original-transaction' }
  | { error: string };

async function fetchCorrelatedPayments(
  action: { providerActionId: string | null },
  creds: { keyId: string; keySecret: string },
  fallbackProviderTransactionId: string | null
): Promise<CorrelatedPayment> {
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');

  if (action.providerActionId) {
    // Round-trip the payment link to the payments it generated.
    try {
      const res = await fetch(
        `https://api.razorpay.com/v1/payment_links/${action.providerActionId}/payments`,
        { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10000) }
      );
      if (res.status === 401) return { error: 'auth' };
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const body = await res.json();
      const payments: any[] = Array.isArray(body?.items) ? body.items : [];
      if (payments.length > 0) return { payments, source: 'payment-link' };
      // Link exists but no payment yet — treat as still pending, not failed.
      return { payments: [], source: 'payment-link' };
    } catch {
      return { error: 'network' };
    }
  }

  // No payment link: fall back to the original transaction's payment status.
  if (!fallbackProviderTransactionId) return { error: 'no-ref' };
  try {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${fallbackProviderTransactionId}`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10000) }
    );
    if (res.status === 401) return { error: 'auth' };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const payment = await res.json();
    return { payments: [payment], source: 'original-transaction' };
  } catch {
    return { error: 'network' };
  }
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

      // Fetch REAL payment status from Razorpay, correlated to the recovery
      // action (via its payment link when one was created — never the original
      // failed payment).
      const correlated = await fetchCorrelatedPayments(
        { providerActionId: action.providerActionId },
        creds,
        c.transaction.providerTransactionId
      );
      if ('error' in correlated) {
        if (correlated.error === 'auth') {
          skipped.push(
            `merchant ${g.merchantId}: Razorpay rejected stored credentials (401)`
          );
          break;
        }
        if (correlated.error === 'no-ref') {
          skipped.push(c.ref ?? c.id);
        } else {
          skipped.push(
            correlated.error === 'HTTP'
              ? `${c.ref ?? c.id} (payment-link fetch failed)`
              : `${c.ref ?? c.id} (network error)`
          );
        }
        continue;
      }

      // No payments recorded against the link yet — still awaiting the
      // customer; leave OUTCOME_PENDING untouched.
      if (correlated.payments.length === 0) {
        skipped.push(`${c.ref ?? c.id} (no payment yet)`);
        continue;
      }

      checked++;

      // A recovery payment link is "recovered" when ANY payment against it is
      // actually captured. authorized alone is NOT money in — it must never be
      // called recovered (an authorized-but-unsettled payment can still fail).
      const captured = correlated.payments.find((p) => p?.status === 'captured');
      const failed = correlated.payments.find((p) => {
        const s = String(p?.status ?? '').toLowerCase();
        return s === 'failed' || s === 'cancelled';
      });
      const now = new Date();

      if (captured) {
        const outcome = await prisma.outcome.create({
          data: {
            actionId: action.id,
            recoveredAmount: c.amountAtRisk,
            result: 'RECOVERED',
            recoveryTimestamp: now,
            measuredCost: action.expectedCost,
            verificationRef: String(captured.id ?? action.providerActionId),
            notes: `Verified via Razorpay API poll (${correlated.source}: payment ${captured.id} captured)`,
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
            evidence: { verificationRef: captured.id, source: 'api-poll', via: correlated.source },
            beforeState: { status: 'OUTCOME_PENDING' },
            afterState: { status: 'RECOVERED' },
            createdAt: now,
          },
        });
        recovered++;
      } else if (failed && !captured) {
        // A payment against the link was attempted and terminally failed and
        // none are captured — record the honest negative outcome.
        const failedPayment = failed;
        const outcome = await prisma.outcome.create({
          data: {
            actionId: action.id,
            recoveredAmount: 0,
            result: 'NOT_RECOVERED',
            recoveryTimestamp: now,
            measuredCost: action.expectedCost,
            verificationRef: String(failedPayment.id ?? action.providerActionId),
            notes: `Provider reports ${failedPayment.status}: ${failedPayment.error_description ?? 'no detail'}`,
            verifiedAt: now,
          },
        });
        await prisma.recoveryAction.update({
          where: { id: action.id },
          data: { outcomeId: outcome.id, completedAt: now },
        });
        await prisma.revenueCase.update({
          where: { id: c.id },
          data: { status: 'FAILED', stoppedReason: `provider_${failedPayment.status}` },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: g.merchantId,
            actorType: 'system',
            actorId: 'outcome-verifier',
            action: 'recovery_outcome_verified',
            entityType: 'revenue_case',
            entityId: c.id,
            reason: `Provider reports ${failedPayment.status} — recovery not achieved`,
            evidence: { verificationRef: failedPayment.id, source: 'api-poll', via: correlated.source },
            beforeState: { status: 'OUTCOME_PENDING' },
            afterState: { status: 'FAILED' },
            createdAt: now,
          },
        });
        notRecovered++;
      } else {
        // authorized / refunded / still processing — leave OUTCOME_PENDING untouched
        const statuses = correlated.payments.map((p) => p?.status).join(',');
        skipped.push(`${c.ref ?? c.id} (status=${statuses})`);
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
