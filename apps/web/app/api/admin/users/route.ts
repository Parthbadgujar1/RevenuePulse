import { NextRequest, NextResponse } from 'next/server';
import { registerUser, hasPermission, USER_ROLES } from '@rp/auth';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    if (!hasPermission(ctx.role, 'users:manage')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Missing permission: users:manage', details: {} } },
        { status: 403 }
      );
    }

    const sp = req.nextUrl.searchParams;
    const search = (sp.get('search') ?? '').trim();

    const users = await prisma.user.findMany({
      where: {
        ...(ctx.userId !== 'anonymous' ? { merchantId: ctx.merchantId } : {}),
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        merchantId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ success: true, data: users, roles: USER_ROLES });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'ADMIN_USERS_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireMerchantContext();
    if (!hasPermission(ctx.role, 'users:manage')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Missing permission: users:manage', details: {} } },
        { status: 403 }
      );
    }

    let body: { name?: string; email?: string; password?: string; role?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON', details: {} } },
        { status: 400 }
      );
    }

    const email = (body.email ?? '').trim().toLowerCase();
    const name = (body.name ?? '').trim();
    const password = body.password ?? '';
    const role = body.role ?? 'FINANCE_MANAGER';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'A valid email is required', details: {} } },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters', details: {} } },
        { status: 400 }
      );
    }
    if (!USER_ROLES.includes(role as (typeof USER_ROLES)[number])) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: `Unknown role: ${role}`, details: {} } },
        { status: 400 }
      );
    }

    const user = await registerUser(
      email,
      password,
      name || email.split('@')[0],
      role as (typeof USER_ROLES)[number],
      ctx.userId !== 'anonymous' ? ctx.merchantId : undefined
    );

    return NextResponse.json({ success: true, data: user }, { status: 201 });
  } catch (err) {
    const message = (err as Error).message;
    const conflict = /already exists/i.test(message);
    return NextResponse.json(
      { success: false, error: { code: conflict ? 'CONFLICT' : 'ADMIN_USERS_ERROR', message, details: {} } },
      { status: conflict ? 409 : 500 }
    );
  }
}
