import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

const CUSTOMER_NAMES = ['Acme Corp', 'TechStart India', 'GlobalTrade Ltd', 'FinanceHub', 'DataSync Inc', 'CloudPeak Solutions', 'InnoVenture', 'SecurePay B2B', 'QuickSettle', 'PrimeDeals'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calcAgingBucket(overdueDays: number): string {
  if (overdueDays <= 0) return 'current';
  if (overdueDays <= 30) return '0-30';
  if (overdueDays <= 60) return '31-60';
  if (overdueDays <= 90) return '61-90';
  return '90+';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const count = Math.min(100, Math.max(5, Number(body?.count) || 20));
    const seed = Number(body?.seed) > 0 ? Math.floor(Number(body?.seed)) : 20260826;

    const { merchantId } = await requireMerchantContext();
    const rng = mulberry32(seed);
    const created = [];

    for (let i = 0; i < count; i++) {
      const amount = Math.floor(rng() * 9500000) + 500000;
      const overdueDays = Math.floor(rng() * 120);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() - overdueDays);
      const status = overdueDays > 60 ? 'overdue' : overdueDays > 0 ? 'pending' : 'paid';
      const amountPaid = status === 'paid' ? amount : Math.floor(amount * rng() * 0.3);
      const issuedAt = new Date();
      issuedAt.setDate(issuedAt.getDate() - overdueDays - 30);
      const now = new Date();

      const inv = await prisma.invoice.create({
        data: {
          merchantId,
          invoiceNumber: `INV-${seed}-${String(i).padStart(4, '0')}`,
          customerName: CUSTOMER_NAMES[Math.floor(rng() * CUSTOMER_NAMES.length)],
          customerEmail: `accounts${i}@example.com`,
          amount,
          amountPaid,
          currency: 'INR',
          status,
          dueDate,
          issuedAt,
          overdueDays,
          agingBucket: calcAgingBucket(overdueDays),
          createdAt: now,
          updatedAt: now,
        },
      });
      created.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, amount, status, overdueDays });
    }

    return NextResponse.json({
      ok: true,
      created: created.length,
      invoices: created,
      note: `Generated ${created.length} invoices.`,
    });
  } catch (err: any) {
    console.error('[demo-generate-receivables]', err);
    return NextResponse.json({ ok: false, error: err?.message ?? 'Internal error' }, { status: 500 });
  }
}
