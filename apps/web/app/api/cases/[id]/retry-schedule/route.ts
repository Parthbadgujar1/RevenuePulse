import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await requireMerchantContext();

  const schedule = await prisma.retrySchedule.findFirst({
    where: { caseId: id, merchantId: ctx.merchantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!schedule) {
    return NextResponse.json({ schedule: null });
  }

  return NextResponse.json({
    schedule: {
      caseId: schedule.caseId,
      failureCategory: schedule.failureCategory,
      retryWindowMinutes: schedule.retryWindowMinutes,
      maxRetries: schedule.maxRetries,
      currentRetry: schedule.currentRetry,
      nextRetryAt: schedule.nextRetryAt?.toISOString() ?? null,
      status: schedule.status,
      attempts: (schedule.attemptHistory as any[] ?? []).map((a: any) => ({
        attemptNumber: a.attemptNumber ?? 0,
        status: a.status ?? 'pending',
        executedAt: a.executedAt ?? null,
        nextRetryAt: a.nextRetryAt ?? null,
        failureCategory: schedule.failureCategory,
      })),
    },
  });
}
