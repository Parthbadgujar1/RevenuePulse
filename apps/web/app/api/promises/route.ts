import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../lib/rate-limit';
import { csrfGuard } from '../../../lib/csrf';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();

    const status = req.nextUrl.searchParams.get('status');
    const from = req.nextUrl.searchParams.get('from');
    const to = req.nextUrl.searchParams.get('to');

    const where: Record<string, unknown> = { merchantId: ctx.merchantId };
    if (status) where.status = status;
    if (from || to) {
      where.promisedDate = {};
      if (from) (where.promisedDate as Record<string, unknown>).gte = new Date(from);
      if (to) (where.promisedDate as Record<string, unknown>).lte = new Date(to);
    }

    const promises = await prisma.promiseToPay.findMany({
      where,
      orderBy: { promisedDate: 'desc' },
      take: 200,
    });

    return NextResponse.json({
      promises: promises.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        customerEmail: p.customerEmail,
        promisedAmount: p.promisedAmount,
        promisedDate: p.promisedDate,
        status: p.status,
        channel: p.channel,
        escalationLevel: p.escalationLevel,
        extendedDate: p.extendedDate,
        keptAt: p.keptAt,
        brokenAt: p.brokenAt,
        createdAt: p.createdAt,
      })),
      total: promises.length,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const csrf = csrfGuard(req);
    if (csrf) return csrf;

    const ctx = await requireMerchantContext();
    const rl = checkRateLimit(req, 'promises', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await req.json().catch(() => null);
    if (!body || typeof body.promisedAmount !== 'number' || typeof body.promisedDate !== 'string') {
      return NextResponse.json({ error: 'Missing required fields: promisedAmount, promisedDate' }, { status: 400 });
    }

    const { invoiceId, customerEmail, promisedAmount, promisedDate, channel, agentNotes } = body as {
      invoiceId?: string;
      customerEmail?: string;
      promisedAmount: number;
      promisedDate: string;
      channel?: string;
      agentNotes?: string;
    };

    if (promisedAmount <= 0) {
      return NextResponse.json({ error: '"promisedAmount" must be positive' }, { status: 400 });
    }

    const now = new Date();
    const promise = await prisma.promiseToPay.create({
      data: {
        invoiceId: invoiceId ?? null,
        merchantId: ctx.merchantId,
        customerEmail: customerEmail ?? null,
        promisedAmount: Math.round(promisedAmount),
        promisedDate: new Date(promisedDate),
        status: 'pending',
        channel: channel ?? null,
        agentNotes: agentNotes ?? null,
        createdAt: now,
      },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'promise_created',
        entityType: 'promise_to_pay',
        entityId: promise.id,
        reason: `Promise to pay ${promisedAmount} created, due ${promisedDate}`,
        afterState: {
          promisedAmount: promise.promisedAmount,
          promisedDate: promise.promisedDate,
          status: 'pending',
        } as any,
        createdAt: now,
      },
    });

    return NextResponse.json({ ok: true, promise });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing "id" query parameter' }, { status: 400 });
    }

    await prisma.promiseToPay.deleteMany({ where: { id, merchantId: ctx.merchantId } });

    await prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'promise_deleted',
        entityType: 'promise_to_pay',
        entityId: id,
        reason: `Promise to pay ${id} deleted`,
        createdAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}
