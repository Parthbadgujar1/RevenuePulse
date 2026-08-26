import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'promise-check-violations', { limit: 10, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const now = new Date();
  const overduePromises = await prisma.promiseToPay.findMany({
    where: {
      merchantId: ctx.merchantId,
      status: 'pending',
      promisedDate: { lt: now },
    },
  });

  if (overduePromises.length === 0) {
    return NextResponse.json({ ok: true, violated: 0, promises: [] });
  }

  const violated: { id: string; customerEmail: string | null; promisedAmount: number; promisedDate: Date; escalationLevel: number }[] = [];
  const ops: unknown[] = [];

  for (const p of overduePromises) {
    const newLevel = p.escalationLevel + 1;
    violated.push({
      id: p.id,
      customerEmail: p.customerEmail,
      promisedAmount: p.promisedAmount,
      promisedDate: p.promisedDate,
      escalationLevel: newLevel,
    });
    ops.push(
      prisma.promiseToPay.update({
        where: { id: p.id },
        data: { status: 'broken', brokenAt: now, escalationLevel: newLevel },
      }),
      prisma.auditLog.create({
        data: {
          merchantId: ctx.merchantId,
          actorType: 'system',
          actorId: 'system',
          action: 'promise_violation_detected',
          entityType: 'promise_to_pay',
          entityId: p.id,
          reason: `Promise expired on ${p.promisedDate.toISOString().slice(0, 10)} — marked as broken`,
          beforeState: { status: 'pending', escalationLevel: p.escalationLevel } as any,
          afterState: { status: 'broken', escalationLevel: newLevel } as any,
          createdAt: now,
        },
      }),
    );
  }

  await prisma.$transaction(ops as []);

  return NextResponse.json({ ok: true, violated: violated.length, promises: violated });
}
