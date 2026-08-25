/**
 * Proxy (formerly middleware) - assigns/propagates a correlation ID for
 * every request so web -> queue -> worker -> ML logs can be traced together.
 *
 * Runs on the Edge runtime by design: Node-only imports (pino etc.) are
 * forbidden here. Route handlers read x-request-id from request headers
 * and bind it into their structured logs via requestLogger().
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const requestId =
    request.headers.get('x-request-id') || crypto.randomUUID().replace(/-/g, '');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
