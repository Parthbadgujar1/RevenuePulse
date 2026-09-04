import { NextResponse } from 'next/server';
import { permissionsForRole, USER_ROLES } from '@rp/auth';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

/**
 * GET /api/auth/me — current session user + effective permissions.
 * In demo fallback (no session) this returns the demo tenant context.
 */
export async function GET() {
  try {
    const ctx = await requireMerchantContext();

    let user = null;
    if (ctx.userId && ctx.userId !== 'anonymous' && ctx.userId !== 'unknown') {
      user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, name: true, email: true, role: true, status: true, merchantId: true },
      });
    }

    const role = (user?.role ?? ctx.role) as string;

    return NextResponse.json({
      success: true,
      data: {
        id: user?.id ?? ctx.userId,
        name: user?.name,
        email: user?.email ?? ctx.email,
        role,
        status: user?.status ?? 'active',
        merchantId: user?.merchantId ?? ctx.merchantId,
        demoFallback: ctx.demoFallback,
        permissions: permissionsForRole(role),
        roles: USER_ROLES,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'AUTH_ME_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
