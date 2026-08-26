/**
 * Admin manual override for case status.
 * POST /api/cases/:id/admin-action
 *
 * Allowed actions:
 *  - retry          Re-enqueue a FAILED/STOPPED case for another attempt
 *  - accept         Mark a FAILED/STOPPED case as permanently closed (NOT_RECOVERED)
 *  - mark_recovered Manually mark an OUTCOME_PENDING case as RECOVERED
 *  - mark_failed    Manually mark an OUTCOME_PENDING case as FAILED
 *  - cancel         Cancel a pending/in-progress action
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';
import { inr } from '../../../../../lib/ui';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit';
import { csrfGuard } from '../../../../../lib/csrf';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const { id: caseId } = await params;
  const ctx = await requireMerchantContext();

  const rl = checkRateLimit(req, 'admin-action', { limit: 20, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== 'string') {
    return NextResponse.json({ error: 'Missing "action" field' }, { status: 400 });
  }
  const { action } = body as { action: string };

  const kase = await prisma.revenueCase.findFirst({
    where: { id: caseId, merchantId: ctx.merchantId },
    include: { transaction: true },
  });
  if (!kase) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 });
  }

  const tx = (kase as any).transaction;
  const txMeta = (tx?.paymentMethodDetails ?? {}) as { simulated?: boolean; source?: string };
  const isLive = txMeta.simulated === false || txMeta.source === 'razorpay-api';

  switch (action) {
    // ── Accept result: close the case permanently ─────────────────────────
    case 'accept': {
      if (!['FAILED', 'STOPPED', 'OUTCOME_PENDING'].includes(kase.status)) {
        return NextResponse.json({ error: `Cannot accept a case with status ${kase.status}` }, { status: 400 });
      }
      await prisma.$transaction([
        prisma.revenueCase.update({
          where: { id: caseId },
          data: { status: 'STOPPED', stoppedReason: 'admin_accepted' },
        }),
        prisma.auditLog.create({
          data: {
            merchantId: ctx.merchantId,
            actorType: 'user',
            actorId: ctx.userId,
            action: 'admin_accept',
            entityType: 'revenue_case',
            entityId: caseId,
            reason: 'Admin accepted result — case closed',
            beforeState: { status: kase.status } as any,
            afterState: { status: 'STOPPED', stoppedReason: 'admin_accepted' } as any,
            createdAt: new Date(),
          },
        }),
      ]);
      return NextResponse.json({ ok: true, status: 'STOPPED' });
    }

    // ── Retry: re-analyze and produce a proposal for admin review ─────────
    case 'retry': {
      if (!['FAILED', 'STOPPED'].includes(kase.status)) {
        return NextResponse.json({ error: `Cannot retry a case with status ${kase.status}` }, { status: 400 });
      }
      // Increment attempt count, reset status to ACTION_PENDING
      const txRow = await prisma.transaction.findUnique({ where: { id: kase.transactionId } });
      if (!txRow) {
        return NextResponse.json({ error: 'Original transaction not found' }, { status: 404 });
      }

      // Use the existing ML prediction to re-propose (or re-score if needed)
      const existingPrediction = await prisma.prediction.findUnique({ where: { caseId } });
      const probability = existingPrediction?.probability ?? 0.5;

      // Build a new recovery action with approval required
      const newAttemptCount = kase.attemptCount + 1;
      const actionType = probability >= 0.3 ? 'retry_later' : 'do_nothing';
      const expectedNet = Math.round(txRow.amount * probability);

      const idempotencyKey = `action:${caseId}:${actionType}:${newAttemptCount}`;
      const newAction = await prisma.recoveryAction.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          caseId,
          actionType,
          policySnapshot: {
            probability,
            rationale: `Admin-initiated retry (attempt ${newAttemptCount}). AI estimates ${(probability * 100).toFixed(0)}% recovery chance.`,
            blockedAlternatives: [],
            violations: [],
            stoppingRuleTriggered: false,
          } as any,
          expectedCost: 0,
          expectedNetRecovery: expectedNet,
          approvalStatus: 'pending',
          executionStatus: 'PENDING',
          idempotencyKey,
        },
      });

      await prisma.revenueCase.update({
        where: { id: caseId },
        data: {
          status: 'ACTION_PENDING',
          stoppedReason: null,
          attemptCount: newAttemptCount,
          lastAttemptAt: new Date(),
          currentActionId: newAction.id,
        },
      });

      await prisma.auditLog.create({
        data: {
          merchantId: ctx.merchantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'admin_retry',
          entityType: 'revenue_case',
          entityId: caseId,
          reason: `Admin initiated retry (attempt ${newAttemptCount}/${3}) — awaiting your approval`,
          evidence: { probability, expectedNet, attemptCount: newAttemptCount } as any,
          beforeState: { status: kase.status, attemptCount: kase.attemptCount } as any,
          afterState: { status: 'ACTION_PENDING', attemptCount: newAttemptCount } as any,
          createdAt: new Date(),
        },
      });

      return NextResponse.json({ ok: true, status: 'ACTION_PENDING', attemptCount: newAttemptCount });
    }

    // ── Mark recovered: manually override OUTCOME_PENDING ─────────────────
    case 'mark_recovered': {
      if (kase.status !== 'OUTCOME_PENDING') {
        return NextResponse.json({ error: `Cannot mark recovered — status is ${kase.status}` }, { status: 400 });
      }
      // Find the latest executed action and create an outcome
      const lastAction = await prisma.recoveryAction.findFirst({
        where: { caseId, executionStatus: 'EXECUTED' },
        orderBy: { id: 'desc' },
      });
      if (!lastAction) {
        return NextResponse.json({ error: 'No executed action found to record outcome against' }, { status: 400 });
      }
      await prisma.$transaction([
        prisma.outcome.upsert({
          where: { actionId: lastAction.id },
          update: {
            result: 'RECOVERED',
            recoveredAmount: kase.amountAtRisk,
            measuredCost: 0,
            verifiedAt: new Date(),
            verificationRef: 'admin-manual-override',
            notes: 'Manually marked as recovered by admin',
          },
          create: {
            actionId: lastAction.id,
            result: 'RECOVERED',
            recoveredAmount: kase.amountAtRisk,
            measuredCost: 0,
            verifiedAt: new Date(),
            verificationRef: 'admin-manual-override',
            notes: 'Manually marked as recovered by admin',
            createdAt: new Date(),
          },
        }),
        prisma.revenueCase.update({
          where: { id: caseId },
          data: { status: 'RECOVERED' },
        }),
        prisma.auditLog.create({
          data: {
            merchantId: ctx.merchantId,
            actorType: 'user',
            actorId: ctx.userId,
            action: 'admin_mark_recovered',
            entityType: 'revenue_case',
            entityId: caseId,
            reason: 'Admin manually confirmed recovery',
            beforeState: { status: kase.status } as any,
            afterState: { status: 'RECOVERED' } as any,
            createdAt: new Date(),
          },
        }),
      ]);
      return NextResponse.json({ ok: true, status: 'RECOVERED' });
    }

    // ── Mark failed: manually close OUTCOME_PENDING as not recovered ──────
    case 'mark_failed': {
      if (kase.status !== 'OUTCOME_PENDING') {
        return NextResponse.json({ error: `Cannot mark failed — status is ${kase.status}` }, { status: 400 });
      }
      const lastAction2 = await prisma.recoveryAction.findFirst({
        where: { caseId, executionStatus: 'EXECUTED' },
        orderBy: { id: 'desc' },
      });
      if (lastAction2) {
        await prisma.outcome.upsert({
          where: { actionId: lastAction2.id },
          update: {
            result: 'NOT_RECOVERED',
            recoveredAmount: 0,
            measuredCost: 0,
            verifiedAt: new Date(),
            verificationRef: 'admin-manual-override',
            notes: 'Manually marked as failed by admin',
          },
          create: {
            actionId: lastAction2.id,
            result: 'NOT_RECOVERED',
            recoveredAmount: 0,
            measuredCost: 0,
            verifiedAt: new Date(),
            verificationRef: 'admin-manual-override',
            notes: 'Manually marked as failed by admin',
            createdAt: new Date(),
          },
        });
      }
      await prisma.$transaction([
        prisma.revenueCase.update({
          where: { id: caseId },
          data: { status: 'FAILED', stoppedReason: 'admin_marked_failed' },
        }),
        prisma.auditLog.create({
          data: {
            merchantId: ctx.merchantId,
            actorType: 'user',
            actorId: ctx.userId,
            action: 'admin_mark_failed',
            entityType: 'revenue_case',
            entityId: caseId,
            reason: 'Admin manually confirmed payment did not go through',
            beforeState: { status: kase.status } as any,
            afterState: { status: 'FAILED' } as any,
            createdAt: new Date(),
          },
        }),
      ]);
      return NextResponse.json({ ok: true, status: 'FAILED' });
    }

    // ── Request refund: initiate refund for money deducted but not recovered ─
    case 'request_refund': {
      if (!['FAILED', 'STOPPED', 'OUTCOME_PENDING'].includes(kase.status)) {
        return NextResponse.json({ error: `Cannot request refund — status is ${kase.status}` }, { status: 400 });
      }
      // Check if a refund is already pending
      const existingRefund = await prisma.refund.findFirst({
        where: { caseId, status: { in: ['pending', 'initiated'] } },
      });
      if (existingRefund) {
        return NextResponse.json({ error: 'A refund is already in progress for this case' }, { status: 400 });
      }
      const refund = await prisma.refund.create({
        data: {
          caseId,
          transactionId: kase.transactionId,
          merchantId: ctx.merchantId,
          amount: kase.amountAtRisk,
          status: 'pending',
          reason: body.reason || 'Admin requested refund — payment not recovered',
          initiatedBy: ctx.userId,
          initiatedAt: new Date(),
        },
      });
      await prisma.auditLog.create({
        data: {
          merchantId: ctx.merchantId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'refund_requested',
          entityType: 'revenue_case',
          entityId: caseId,
          reason: `Refund of ${inr(kase.amountAtRisk)} requested by admin`,
          evidence: { refundId: refund.id, amount: kase.amountAtRisk } as any,
          createdAt: new Date(),
        },
      });
      return NextResponse.json({ ok: true, refundId: refund.id, status: 'pending' });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
