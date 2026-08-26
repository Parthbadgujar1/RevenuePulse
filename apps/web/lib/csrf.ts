/**
 * CSRF defense-in-depth: double-submit cookie pattern.
 *
 * NextAuth's session cookie is SameSite=Lax, which blocks the classic
 * cross-site form POST. As defense-in-depth for browser sessions, mutating
 * routes additionally require an `x-rp-csrf` header that matches the
 * `rp_csrf` cookie (issued by proxy.ts).
 *
 * Requests WITHOUT a session cookie (curl, server-to-server, webhooks,
 * provider integrations) skip the check entirely — they carry no ambient
 * credentials to abuse.
 */
import { NextResponse } from 'next/server';

export const CSRF_COOKIE = 'rp_csrf';
export const CSRF_HEADER = 'x-rp-csrf';

function hasSessionCookie(req: Request): boolean {
  const cookie = req.headers.get('cookie') ?? '';
  // next-auth session cookies (v4): next-auth.session-token / __Secure-next-auth.session-token
  return /(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=/.test(cookie);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns a 403 response when a cookie-authenticated request fails the
 * double-submit check; null when the request may proceed.
 */
export function csrfGuard(req: Request): NextResponse | null {
  if (!hasSessionCookie(req)) return null;

  const cookieHeader = req.headers.get('cookie') ?? '';
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`)
  );
  const cookieToken = match?.[1] ? decodeURIComponent(match[1]) : '';
  const headerToken = req.headers.get(CSRF_HEADER) ?? '';

  if (!cookieToken || !headerToken || !timingSafeEqualStr(cookieToken, headerToken)) {
    return NextResponse.json(
      { error: 'CSRF validation failed' },
      { status: 403 }
    );
  }
  return null;
}
