import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { csrfGuard } from '../../../../lib/csrf';

function computeAgingBucket(overdueDays: number): string {
  if (overdueDays <= 0) return 'current';
  if (overdueDays <= 30) return '0-30';
  if (overdueDays <= 60) return '31-60';
  if (overdueDays <= 90) return '61-90';
  return '90+';
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();

    const status = req.nextUrl.searchParams.get('status');
    const agingBucket = req.nextUrl.searchParams.get('agingBucket');

    const where: Record<string, unknown> = { merchantId: ctx.merchantId };
    if (status) where.status = status;
    if (agingBucket) where.agingBucket = agingBucket;

    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { dueDate: 'desc' },
      take: 200,
    });

    return NextResponse.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        customerEmail: inv.customerEmail,
        amount: inv.amount,
        currency: inv.currency,
        dueDate: inv.dueDate,
        status: inv.status,
        amountPaid: inv.amountPaid,
        overdueDays: inv.overdueDays,
        agingBucket: inv.agingBucket,
        lastChasedAt: inv.lastChasedAt,
        chaseCount: inv.chaseCount,
        createdAt: inv.createdAt,
      })),
      total: invoices.length,
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
    const rl = checkRateLimit(req, 'invoices', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await req.json().catch(() => null);
    if (!body || typeof body.customerName !== 'string' || typeof body.amount !== 'number') {
      return NextResponse.json({ error: 'Missing required fields: customerName, amount' }, { status: 400 });
    }

    const { customerName, customerEmail, customerPhone, amount, currency, dueDate, items } = body as {
      customerName: string;
      customerEmail?: string;
      customerPhone?: string;
      amount: number;
      currency?: string;
      dueDate?: string;
      items?: unknown;
    };

    if (amount <= 0) {
      return NextResponse.json({ error: '"amount" must be positive' }, { status: 400 });
    }

    const now = new Date();
    const invoiceCount = await prisma.invoice.count({ where: { merchantId: ctx.merchantId } });
    const invoiceNumber = `INV-${String(invoiceCount + 1).padStart(5, '0')}`;
    const due = dueDate ? new Date(dueDate) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const overdueDays = Math.max(0, Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        merchantId: ctx.merchantId,
        customerName,
        customerEmail: customerEmail ?? null,
        customerPhone: customerPhone ?? null,
        amount: Math.round(amount),
        currency: currency ?? 'INR',
        dueDate: due,
        issuedAt: now,
        status: overdueDays > 0 ? 'overdue' : 'pending',
        overdueDays,
        agingBucket: computeAgingBucket(overdueDays),
        createdAt: now,
      },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'invoice_created',
        entityType: 'invoice',
        entityId: invoice.id,
        reason: `Invoice ${invoiceNumber} created for ${customerName}`,
        afterState: { invoiceNumber, amount: invoice.amount, status: invoice.status } as any,
        createdAt: now,
      },
    });

    return NextResponse.json({ ok: true, invoice });
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

    await prisma.invoice.deleteMany({ where: { id, merchantId: ctx.merchantId } });

    await prisma.auditLog.create({
      data: {
        merchantId: ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'invoice_deleted',
        entityType: 'invoice',
        entityId: id,
        reason: `Invoice ${id} deleted`,
        createdAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}
