import type { PrismaClient } from '../prisma/generated/prisma/client';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'danger';

export interface NotificationInput {
  merchantId: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * Create an in-app notification row for a merchant.
 * Non-throwing: notification persistence must never break the primary
 * processing path (queue jobs, webhooks, route handlers).
 *
 * `prisma` is passed in (not imported) to avoid circular module imports,
 * matching the idempotency layer's convention.
 */
export async function writeNotification(
  prisma: PrismaClient,
  input: NotificationInput
): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        merchantId: input.merchantId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        createdAt: new Date(),
      },
    });
  } catch (err) {
    console.error('[notifications] failed to persist notification:', err);
  }
}
