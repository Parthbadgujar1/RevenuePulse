import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../../lib/merchant-context';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireMerchantContext();
    const { id } = await params;

    const notification = await prisma.notification.findFirst({
      where: { id, merchantId: ctx.merchantId },
    });
    if (!notification) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Notification not found', details: {} } },
        { status: 404 }
      );
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: notification.readAt ? {} : { readAt: new Date() },
    });

    return NextResponse.json({
      success: true,
      data: { id: updated.id, readAt: updated.readAt ? updated.readAt.toISOString() : null },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { code: 'NOTIFICATION_ERROR', message: (err as Error).message, details: {} } },
      { status: 500 }
    );
  }
}
