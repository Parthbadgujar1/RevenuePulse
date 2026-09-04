import { NextRequest, NextResponse } from 'next/server';
import { prisma, type TransactionWhereInput } from '@rp/database';
import { requireMerchantContext, ForbiddenError, apiErrorStatus } from '../../../lib/merchant-context';

const SORTABLE = new Set([
  'occurredAt',
  'amount',
  'status',
  'paymentMethod',
  'createdAt',
]);
const DIRECTIONS = new Set(['asc', 'desc']);

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const sp = req.nextUrl.searchParams;

    const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
    const pageSizeRaw = Number.parseInt(sp.get('pageSize') ?? '25', 10) || 25;
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw));

    const search = (sp.get('search') ?? '').trim();
    const status = sp.get('status') ?? '';
    const paymentMethod = sp.get('paymentMethod') ?? '';
    const from = sp.get('from');
    const to = sp.get('to');
    const sort = SORTABLE.has(sp.get('sort') ?? '') ? (sp.get('sort') as string) : 'occurredAt';
    const direction = DIRECTIONS.has(sp.get('direction') ?? '')
      ? (sp.get('direction') as 'asc' | 'desc')
      : 'desc';

    const where: TransactionWhereInput = {
      merchantId: ctx.merchantId,
    };

    if (status) where.status = status;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    if (from || to) {
      const range: { gte?: Date; lte?: Date } = {};
      const parsedFrom = from ? new Date(from) : null;
      const parsedTo = to ? new Date(to) : null;
      if (parsedFrom && !Number.isNaN(parsedFrom.getTime())) range.gte = parsedFrom;
      if (parsedTo && !Number.isNaN(parsedTo.getTime())) range.lte = parsedTo;
      where.occurredAt = range;
    }

    if (search) {
      where.OR = [
        { providerTransactionId: { contains: search, mode: 'insensitive' } },
        { paymentMethod: { contains: search, mode: 'insensitive' } },
        { status: { contains: search, mode: 'insensitive' } },
        { failureCode: { contains: search, mode: 'insensitive' } },
        { failureCategory: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { [sort]: direction },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          revenueCases: { select: { id: true, ref: true, status: true } },
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: rows.map((t) => ({
        id: t.id,
        providerTransactionId: t.providerTransactionId,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        paymentMethod: t.paymentMethod,
        failureCode: t.failureCode,
        failureCategory: t.failureCategory,
        failureMessage: t.failureMessage,
        occurredAt: t.occurredAt.toISOString(),
        createdAt: t.createdAt.toISOString(),
        cases: t.revenueCases,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      filters: { search, status, paymentMethod, from, to, sort, direction },
    });
  } catch (err) {
    const status = err instanceof ForbiddenError ? 403 : apiErrorStatus(err);
    return NextResponse.json(
      { success: false, error: { code: 'TRANSACTIONS_ERROR', message: (err as Error).message, details: {} } },
      { status }
    );
  }
}
