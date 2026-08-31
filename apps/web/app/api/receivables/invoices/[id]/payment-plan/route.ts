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
  const rl = checkRateLimit(req, 'payment-plan', { limit: 20, windowMs: 60_000 }, ctx.merchantId);
  if (!rl.allowed) return rateLimitResponse(rl);

  const invoice = await prisma.invoice.findFirst({
    where: { id, merchantId: ctx.merchantId },
  });
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const existingPlan = await prisma.paymentPlan.findFirst({
    where: { invoiceId: id, status: 'active' },
  });
  if (existingPlan) {
    return NextResponse.json({ error: 'An active payment plan already exists for this invoice' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const rawInstallments = body?.installments;
  if (
    !Number.isInteger(rawInstallments) ||
    rawInstallments < 2 ||
    rawInstallments > 24
  ) {
    return NextResponse.json(
      { error: '"installments" must be an integer between 2 and 24' },
      { status: 400 },
    );
  }

  const { installments, startDate } = body as { installments: number; startDate?: string };
  const start = startDate ? new Date(startDate) : new Date();
  const remaining = invoice.amount - invoice.amountPaid;
  const baseAmount = Math.floor(remaining / installments);
  const remainder = remaining - baseAmount * installments;

  const schedule = Array.from({ length: installments }, (_, i) => {
    const dueDate = new Date(start);
    dueDate.setMonth(dueDate.getMonth() + i);
    const amount = i === 0 ? baseAmount + remainder : baseAmount;
    return {
      installment: i + 1,
      amount,
      dueDate: dueDate.toISOString().slice(0, 10),
      status: 'pending',
    };
  });

  const now = new Date();
  const plan = await prisma.paymentPlan.create({
    data: {
      invoiceId: id,
      merchantId: ctx.merchantId,
      totalAmount: remaining,
      installments: schedule as any,
      status: 'active',
      createdAt: now,
    },
  });

  await prisma.auditLog.create({
    data: {
      merchantId: ctx.merchantId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'payment_plan_created',
      entityType: 'payment_plan',
      entityId: plan.id,
      reason: `Payment plan with ${installments} installments created for invoice ${invoice.invoiceNumber}`,
      evidence: { installments, totalAmount: remaining } as any,
      afterState: { planId: plan.id, status: 'active', installmentCount: installments } as any,
      createdAt: now,
    },
  });

  return NextResponse.json({ ok: true, plan });
}
