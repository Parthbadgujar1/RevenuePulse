import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await requireMerchantContext();

    const schedule = await prisma.retrySchedule.findFirst({
      where: { caseId: id, merchantId: ctx.merchantId },
      orderBy: { createdAt: 'desc' },
    });

    if (!schedule) {
      return NextResponse.json({ schedule: null });
    }

    const retryWindowMinutes =
      ((schedule.retryWindow as any)?.baseHours ?? 0) * 60 || null;

    const attempts = [];
    for (let i = 0; i < schedule.currentRetry; i++) {
      attempts.push({
        attemptNumber: i + 1,
        status:
          i < schedule.currentRetry - 1
            ? 'completed'
            : schedule.status === 'executing'
              ? 'executing'
              : 'completed',
        executedAt: null,
        nextRetryAt: null,
        failureCategory: schedule.failureCategory,
      });
    }

    return NextResponse.json({
      schedule: {
        caseId: schedule.caseId,
        failureCategory: schedule.failureCategory,
        retryWindowMinutes,
        maxRetries: schedule.maxRetries,
        currentRetry: schedule.currentRetry,
        nextRetryAt: schedule.nextRetryAt?.toISOString() ?? null,
        status: schedule.status,
        attempts,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch retry schedule' },
      { status: 500 }
    );
  }
}
