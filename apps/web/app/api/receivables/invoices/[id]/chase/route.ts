import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../../../lib/rate-limit';
import { csrfGuard } from '../../../../../../lib/csrf';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const { id } = await params;
  const ctx = await requireMerchantContext();
  const rl = checkRateLimit(req, 'chase', { limit: 20, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const invoice = await prisma.invoice.findFirst({
    where: { id, merchantId: ctx.merchantId },
  });
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (!body || !['email', 'sms', 'whatsapp'].includes(body.channel)) {
    return NextResponse.json({ error: 'Missing or invalid "channel" (email|sms|whatsapp)' }, { status: 400 });
  }

  const { channel, message } = body as { channel: string; message?: string };
  const now = new Date();

  const [updated] = await prisma.$transaction([
    prisma.invoice.update({
      where: { id },
      data: {
        lastChasedAt: now,
        chaseCount: { increment: 1 },
      },
    }),
    prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'invoice_chased',
        entityType: 'invoice',
        entityId: id,
        reason: `Payment reminder sent via ${channel}`,
        evidence: { channel, message: message ?? null, chaseCount: invoice.chaseCount + 1 } as any,
        beforeState: { lastChasedAt: invoice.lastChasedAt, chaseCount: invoice.chaseCount } as any,
        afterState: { lastChasedAt: now, chaseCount: invoice.chaseCount + 1 } as any,
        createdAt: now,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    invoiceId: updated.id,
    channel,
    lastChasedAt: updated.lastChasedAt,
    chaseCount: updated.chaseCount,
  });
}
