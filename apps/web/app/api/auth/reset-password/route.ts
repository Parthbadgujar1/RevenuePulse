/**
 * POST /api/auth/reset-password
 * Consumes a single-use reset token and sets the new password.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resetPasswordWithToken } from '@rp/auth';
import { logger, newRequestId } from '@rp/observability';
import { parseJsonBody } from '../../../../lib/validate';
import { z } from 'zod';

export const runtime = 'nodejs';

const ResetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  const log = logger.child({ requestId: req.headers.get('x-request-id') ?? newRequestId(), route: 'auth/reset-password' });
  try {
    const parsed = await parseJsonBody(req, ResetPasswordSchema);
    if (!parsed.ok) return parsed.response;
    const { token, newPassword } = parsed.data;

    await resetPasswordWithToken(token, newPassword);
    log.info('password reset completed');
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    log.warn({ err: e?.message }, 'password reset rejected');
    return NextResponse.json(
      { error: e?.message ?? 'Invalid or expired token' },
      { status: 400 }
    );
  }
}
