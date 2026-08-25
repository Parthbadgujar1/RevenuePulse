/**
 * GET /api/health — liveness probe.
 * Returns 200 as long as the process can serve HTTP. No dependency checks.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() });
}
