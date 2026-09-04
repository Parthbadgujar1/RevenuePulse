import { NextRequest, NextResponse } from 'next/server';
import { hasPermission } from '@rp/auth';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    if (!hasPermission(ctx.role, 'audit:view')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Missing permission: audit:view', details: {} } },
        { status: 403 }
      );
    }

    const sp = req.nextUrl.searchParams;
    const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '50', 10) || 50));
    const action = (sp.get('action') ?? '').trim();
    const actorType = (sp.get('actorType') ?? '').trim();

    const where = {
      merchantId: ctx.merchantId,
      ...(action ? { action } : {}),
      ...(actorType ? { actorType } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          actorType: true,
          actorId: true,
          action: true,
          entityType: true,
          entityId: true,
          reason: true,
          evidence: true,
          beforeState: true,
          afterState: true,
          createdAt: true,
        },
      }),
    ]);

    const actions = await prisma.auditLog.findMany({
      where: { merchantId: ctx.merchantId },
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });

    return NextResponse.json({
      success: true,
      data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      actions: actions.map((a) => a.action),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'AUDIT_LOG_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
