/**
 * GET /api/ready — readiness probe.
 * Verifies critical dependencies before declaring ready:
 *   - database: SELECT 1
 *   - ml: GET ${ML_SERVICE_URL}/health (2s timeout)
 *   - env: validateProductionEnv() (production only)
 * Returns 503 with per-dependency detail when any check fails.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { validateProductionEnv } from '../../../lib/env';

export const runtime = 'nodejs';

const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8001';

async function checkDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'database unreachable' };
  }
}

async function checkMl(): Promise<{ ok: boolean; error?: string; modelVersion?: string }> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { ok: false, error: `ml service returned ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      model_version?: string;
    };
    return { ok: true, modelVersion: body.model_version };
  } catch (e: any) {
    return {
      ok: false,
      error:
        e?.message ??
        `ml service unreachable at ${ML_SERVICE_URL} (set RP_ML_FALLBACK=heuristic only for dev)`,
    };
  }
}

export async function GET() {
  const checks = {
    db: await checkDb(),
    ml: await checkMl(),
    env: (() => {
      const problems = validateProductionEnv();
      return problems.length === 0
        ? { ok: true }
        : { ok: false, error: problems.join('; ') };
    })(),
  };

  const ok = checks.db.ok && checks.ml.ok && checks.env.ok;
  return NextResponse.json(
    { status: ok ? 'ready' : 'degraded', checks },
    { status: ok ? 200 : 503 }
  );
}
