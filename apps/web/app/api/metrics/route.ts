/**
 * GET /api/metrics — Prometheus scrape endpoint (text exposition format).
 *
 * Authentication: requires an internal Metrics token so the endpoint cannot
 * be scraped by the public internet. Callers must present
 * `Authorization: Bearer <METRICS_TOKEN>`. When METRICS_TOKEN is unset the
 * endpoint responds 404 (hidden) so it is never accidentally exposed.
 */
import { NextRequest } from 'next/server';
import { metricsToText } from '@rp/observability';

export const runtime = 'nodejs';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: NextRequest) {
  const expected = process.env.METRICS_TOKEN ?? process.env.RP_METRICS_TOKEN ?? '';
  if (!expected) {
    // Not configured → hide the endpoint so it is not exposed by default.
    return new Response('Not found', { status: 404 });
  }
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(provided, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const text = await metricsToText();
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  } catch (e: any) {
    return new Response(`# metrics unavailable: ${e?.message ?? 'error'}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
