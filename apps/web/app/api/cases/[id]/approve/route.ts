/**
 * Approve a pending recovery action for a case, then execute it immediately.
 * POST /api/cases/:id/approve
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { processJob, JobType } from '@rp/observability';
import { requireMerchantContext } from '../../../../../lib/merchant-context';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const ctx = await requireMerchantContext();

  // Ownership check: the case must belong to the caller's merchant.
  const kase = await prisma.revenueCase.findFirst({
    where: { id: caseId, merchantId: ctx.merchantId },
  });
  if (!kase) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 });
  }

  const action = await prisma.recoveryAction.findFirst({
    where: { caseId, approvalStatus: 'pending' },
    orderBy: { id: 'desc' },
  });
  if (!action) {
    return NextResponse.json({ error: 'No pending action for this case' }, { status: 404 });
  }

  await prisma.recoveryAction.update({
    where: { id: action.id },
    data: {
      approvalStatus: 'approved',
      approverId: ctx.userId,
      approvedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      merchantId: kase.merchantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'action_approved',
      entityType: 'recovery_action',
      entityId: action.id,
      reason: `Human approval granted for ${action.actionType}`,
      evidence: { expectedNetRecovery: action.expectedNetRecovery } as any,
      beforeState: { approvalStatus: 'pending' } as any,
      afterState: { approvalStatus: 'approved' } as any,
      createdAt: new Date(),
    },
  });

  // Live vs simulated follows the case's data source (same rule as auto-exec).
  const tx = await prisma.transaction.findUnique({
    where: { id: kase.transactionId },
    select: { paymentMethodDetails: true },
  });
  const txMeta = (tx?.paymentMethodDetails ?? {}) as { simulated?: boolean; source?: string };
  const isLiveSource = txMeta.simulated === false || txMeta.source === 'razorpay-api';

  const result = await processJob({} as any, JobType.EXECUTE_ACTION, {
    actionId: action.id,
    simulated: !isLiveSource,
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    actionId: action.id,
    execution: result.result,
  });
}
