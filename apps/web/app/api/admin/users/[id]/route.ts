import { NextRequest, NextResponse } from 'next/server';
import { hasPermission, USER_ROLES } from '@rp/auth';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireMerchantContext();
    if (!hasPermission(ctx.role, 'users:manage')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Missing permission: users:manage', details: {} } },
        { status: 403 }
      );
    }

    const { id } = await params;
    let body: { status?: string; role?: string; name?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON', details: {} } },
        { status: 400 }
      );
    }

    const target = ctx.userId !== 'anonymous'
      ? await prisma.user.findFirst({ where: { id, merchantId: ctx.merchantId } })
      : await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'User not found', details: {} } },
        { status: 404 }
      );
    }

    if (body.status && !['active', 'deactivated'].includes(body.status)) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Status must be active or deactivated', details: {} } },
        { status: 400 }
      );
    }
    if (body.role && !USER_ROLES.includes(body.role as (typeof USER_ROLES)[number])) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: `Unknown role: ${body.role}`, details: {} } },
        { status: 400 }
      );
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
      },
      select: { id: true, name: true, email: true, role: true, status: true, merchantId: true },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: target.merchantId ?? ctx.merchantId,
        actorType: 'user',
        actorId: ctx.userId === 'anonymous' ? 'demo' : ctx.userId,
        action: 'user_updated',
        entityType: 'user',
        entityId: target.id,
        reason: `Field(s) changed: ${Object.keys(body).join(', ')}`,
        beforeState: { role: target.role, status: target.status } as any,
        afterState: { role: updated.role, status: updated.status } as any,
        createdAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'ADMIN_USER_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
