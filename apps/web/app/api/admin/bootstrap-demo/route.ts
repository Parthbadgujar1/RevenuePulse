/**
 * POST /api/admin/bootstrap-demo — one-time (idempotent) seed of the demo
 * merchant + owner account (owner@revenuepulse.dev / demo1234) shown on the
 * sign-in page.
 *
 * The equivalent dev-only self-heal (ensureDemoOwner in @rp/auth) is
 * deliberately skipped in production — this route is the explicit,
 * secret-gated opt-in for a production deployment that's meant to run as a
 * public demo. Requires `Authorization: Bearer <ADMIN_BOOTSTRAP_TOKEN>`;
 * responds 404 (hidden) when that token isn't configured, matching the
 * /api/metrics pattern, so it's never exposed by default.
 */
import { NextRequest } from 'next/server';
import { bootstrapDemoOwner } from '@rp/auth';

export const runtime = 'nodejs';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN ?? '';
  if (!expected) {
    return new Response('Not found', { status: 404 });
  }
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(provided, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await bootstrapDemoOwner();
    return Response.json({ ok: true, ...result });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? 'error' }, { status: 500 });
  }
}
