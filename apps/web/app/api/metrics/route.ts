/**
 * GET /api/metrics — Prometheus scrape endpoint (text exposition format).
 *
 * Intended for an internal network / trusted scraper only. Do not expose
 * publicly without network-level protection or scraping auth at the proxy.
 */
import { metricsToText } from '@rp/observability';

export const runtime = 'nodejs';

export async function GET() {
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
