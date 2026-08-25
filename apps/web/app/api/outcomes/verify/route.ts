/**
 * Verify pending LIVE recovery outcomes against the real Razorpay API.
 * POST /api/outcomes/verify
 *
 * For every OUTCOME_PENDING case (live executions awaiting a provider
 * outcome), fetch the payment status from api.razorpay.com:
 *   captured            -> Outcome RECOVERED, verified with provider ref
 *   failed / cancelled  -> Outcome NOT_RECOVERED, honest failure recorded
 * No outcome is ever fabricated — this endpoint only records what Razorpay
 * itself reports. Complements webhook-driven resolution for setups without
 * webhooks configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { resolveRazorpayCredentials } from '../../../../lib/razorpay-creds';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const creds = await resolveRazorpayCredentials(ctx.merchantId);
    if ('error' in creds) {
      return NextResponse.json({ error: creds.error }, { status: 400 });
    }
    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');

    const pendingCases = await prisma.revenueCase.findMany({
      where: { merchantId: ctx.merchantId, status: 'OUTCOME_PENDING' },
      include: { transaction: { select: { id: true, providerTransactionId: true } } },
      orderBy: { createdAt: 'asc' as const },
      take: 50,
    });

    let checked = 0;
    let recovered = 0;
    let notRecovered = 0;
    const skipped: string[] = [];

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
        if (!res.ok) {
          if (res.status === 401) {
            return NextResponse.json(
              { error: 'Razorpay rejected the stored credentials (401). Reconnect on /integrations.' },
              { status: 401 }
            );
          }
          skipped.push(`${c.ref ?? c.id} (HTTP ${res.status})`);
          continue;
        }
        payment = await res.json();
      } catch (e: any) {
        return NextResponse.json(
          { error: `Could not reach api.razorpay.com: ${e?.message ?? 'network error'}` },
          { status: 502 }
        );
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
            notes: `Verified via Razorpay API poll (status=${payment.status})`,
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
            merchantId: ctx.merchantId,
            actorType: 'system',
            actorId: 'outcome-verifier',
            action: 'recovery_outcome_verified',
            entityType: 'revenue_case',
            entityId: c.id,
            reason: `Provider reports ${payment.status} — ₹${(c.amountAtRisk / 100).toLocaleString('en-IN')} recovered`,
            evidence: { verificationRef: payment.id, source: 'api-poll' } as any,
            beforeState: { status: 'OUTCOME_PENDING' } as any,
            afterState: { status: 'RECOVERED' } as any,
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
            merchantId: ctx.merchantId,
            actorType: 'system',
            actorId: 'outcome-verifier',
            action: 'recovery_outcome_verified',
            entityType: 'revenue_case',
            entityId: c.id,
            reason: `Provider reports ${payment.status} — recovery not achieved`,
            evidence: { verificationRef: payment.id, source: 'api-poll' } as any,
            beforeState: { status: 'OUTCOME_PENDING' } as any,
            afterState: { status: 'FAILED' } as any,
            createdAt: now,
          },
        });
        notRecovered++;
      } else {
        // pending / still processing — leave OUTCOME_PENDING untouched
        skipped.push(`${c.ref ?? c.id} (status=${payment.status})`);
        checked--;
      }
    }

    return NextResponse.json({
      ok: true,
      pendingCases: pendingCases.length,
      checked,
      recovered,
      notRecovered,
      skipped,
    });
  } catch (e: any) {
    console.error('[outcomes/verify] error:', e);
    return NextResponse.json({ error: e?.message ?? 'Verification failed' }, { status: 500 });
  }
}
