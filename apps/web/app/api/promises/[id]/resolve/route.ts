import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit';
import { csrfGuard } from '../../../../../lib/csrf';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const { id } = await params;
  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'promise-resolve', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const promise = await prisma.promiseToPay.findFirst({
    where: { id, merchantId: ctx.merchantId },
  });
  if (!promise) {
    return NextResponse.json({ error: 'Promise not found' }, { status: 404 });
  }
  if (promise.status !== 'pending') {
    return NextResponse.json({ error: `Cannot resolve promise with status "${promise.status}"` }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || !['kept', 'broken', 'extended'].includes(body.status)) {
    return NextResponse.json({ error: 'Missing or invalid "status" (kept|broken|extended)' }, { status: 400 });
  }

  const { status: resolution, extendedDate } = body as {
    status: string;
    extendedDate?: string;
  };

  const now = new Date();
  const updateData: Record<string, unknown> = { status: resolution };

  if (resolution === 'kept') {
    updateData.keptAt = now;
  } else if (resolution === 'broken') {
    updateData.brokenAt = now;
    updateData.escalationLevel = { increment: 1 };
  } else if (resolution === 'extended') {
    updateData.extendedDate = extendedDate ? new Date(extendedDate) : now;
    updateData.promisedDate = extendedDate ? new Date(extendedDate) : now;
    updateData.escalationLevel = { increment: 1 };
  }

  const [updated] = await prisma.$transaction([
    prisma.promiseToPay.update({ where: { id }, data: updateData }),
    prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: `promise_${resolution}`,
        entityType: 'promise_to_pay',
        entityId: id,
        reason: `Promise resolved as "${resolution}"`,
        beforeState: { status: promise.status, escalationLevel: promise.escalationLevel } as any,
        afterState: {
          status: resolution,
          escalationLevel: resolution === 'kept' ? promise.escalationLevel : promise.escalationLevel + 1,
        } as any,
        createdAt: now,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, promise: updated });
}
