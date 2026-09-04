/**
 * POST /api/auth/forgot-password
 *
 * Issues a single-use, 1h password-reset token for the account.
 * Always responds 200 with a generic body to prevent account enumeration;
 * the raw token is only written to server logs (dev) — wire an email
 * provider here for production delivery.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createPasswordResetToken } from '@rp/auth';
import { logger, newRequestId } from '@rp/observability';
import { parseJsonBody } from '../../../../lib/validate';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit';
import { z } from 'zod';

export const runtime = 'nodejs';

const ForgotPasswordSchema = z.object({
  email: z.string().email().max(320),
});

export async function POST(req: NextRequest) {
  const log = logger.child({ requestId: req.headers.get('x-request-id') ?? newRequestId(), route: 'auth/forgot-password' });
  const rl = checkRateLimit(req, 'auth', { limit: 5, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const parsed = await parseJsonBody(req, ForgotPasswordSchema);
    if (parsed.ok === false) return parsed.response;
    const { email } = parsed.data;

    const token = await createPasswordResetToken(email);
    if (token) {
      // Delivery channel: transactional email (SendGrid/SES) in production.
      // Without SMTP configured, the token is written to server logs only in
      // non-production — keeping local dev usable without revealing it
      // publicly. The public response is intentionally generic to prevent
      // account enumeration.
      log.info({ recipientDomain: email.split('@')[1] }, 'password reset token issued');
      if (process.env.NODE_ENV !== 'production') {
        log.warn({ token }, 'DEV ONLY - password reset token');
      }
    }

    return NextResponse.json({
      ok: true,
      message: 'If the account exists, a reset link has been sent.',
    });
  } catch (e: any) {
    log.error({ err: e?.message }, 'forgot-password failed');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
