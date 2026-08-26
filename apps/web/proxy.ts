/**
 * Proxy (formerly middleware).
 *
 * 1. Assigns/propagates a correlation ID for every request so
 *    web -> queue -> worker -> ML logs can be traced together.
 * 2. Issues the rp_csrf double-submit cookie used by mutating routes as
 *    defense-in-depth against cross-site request forgery (lib/csrf.ts).
 *
 * Runs on the Edge runtime by design: Node-only imports (pino etc.) are
 * forbidden here.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const CSRF_COOKIE = 'rp_csrf';

export function proxy(request: NextRequest) {
  const requestId =
    request.headers.get('x-request-id') || crypto.randomUUID().replace(/-/g, '');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-request-id', requestId);

  // Issue a CSRF token if the browser doesn't have one yet. Readable by JS
  // (not HttpOnly) by design — the double-submit pattern requires it.
  if (!request.cookies.get(CSRF_COOKIE)?.value) {
    response.cookies.set(CSRF_COOKIE, crypto.randomUUID(), {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24, // 24h
    });
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
