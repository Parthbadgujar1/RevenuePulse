/**
 * Approve a pending recovery action for a case, then execute it immediately.
 * POST /api/cases/:id/approve
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { processJob, JobType } from '@rp/observability';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;

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
      approverId: 'demo-user',
      approvedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      merchantId: (await prisma.revenueCase.findUnique({ where: { id: caseId } }))?.merchantId || 'demo-merchant',
      actorType: 'user',
      actorId: 'demo-user',
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

  const result = await processJob({} as any, JobType.EXECUTE_ACTION, {
    actionId: action.id,
    simulated: true,
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
