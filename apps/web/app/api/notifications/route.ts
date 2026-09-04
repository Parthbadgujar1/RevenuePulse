import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    const sp = req.nextUrl.searchParams;

    const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '30', 10) || 30));
    const unreadOnly = sp.get('unread') === 'true';
    const severity = sp.get('severity') ?? '';

    const where = {
      merchantId: ctx.merchantId,
      ...(unreadOnly ? { readAt: null } : {}),
      ...(severity ? { severity } : {}),
    };

    const [total, unreadCount, items] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { merchantId: ctx.merchantId, readAt: null } }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({
      success: true,
      unread: unreadCount,
      data: items.map((n) => ({
        id: n.id,
        type: n.type,
        severity: n.severity,
        title: n.title,
        message: n.message,
        entityType: n.entityType,
        entityId: n.entityId,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'NOTIFICATIONS_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
