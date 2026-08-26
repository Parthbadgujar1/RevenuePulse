/**
 * In-process sliding-window rate limiter.
 *
 * Keyed by bucket name + client IP. Suitable for single-instance
 * deployments; swap the store for Redis when running multiple replicas.
 *
 * Usage in a route handler:
 *   const rl = checkRateLimit(req, 'webhook', { limit: 100, windowMs: 60_000 });
 *   if (!rl.allowed) return rateLimitResponse(rl);
 */
import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the oldest counted request leaves the window. */
  resetAt: number;
  retryAfterSeconds?: number;
}

interface BucketEntry {
  timestamps: number[];
}

const globalForLimiter = globalThis as unknown as {
  __revenuePulseRateBuckets?: Map<string, BucketEntry>;
};

const buckets: Map<string, BucketEntry> =
  globalForLimiter.__revenuePulseRateBuckets ?? new Map();
globalForLimiter.__revenuePulseRateBuckets = buckets;

/** Best-effort client IP (proxy headers first, then remote). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// Periodic sweep so long-tail IPs don't leak memory.
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of buckets) {
    if (entry.timestamps.length === 0) buckets.delete(key);
  }
}

export function checkRateLimit(
  req: Request,
  bucketName: string,
  opts: RateLimitOptions,
  keyOverride?: string
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const key = `${bucketName}:${keyOverride ?? clientIp(req)}`;
  const entry = buckets.get(key) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < opts.windowMs);

  if (entry.timestamps.length >= opts.limit) {
    buckets.set(key, entry);
    const resetAt = entry.timestamps[0] + opts.windowMs;
    return {
      allowed: false,
      limit: opts.limit,
      remaining: 0,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  entry.timestamps.push(now);
  buckets.set(key, entry);

  return {
    allowed: true,
    limit: opts.limit,
    remaining: opts.limit - entry.timestamps.length,
    resetAt: entry.timestamps[0] + opts.windowMs,
  };
}

/** Uniform 429 response with standard headers. */
export function rateLimitResponse(rl: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests. Retry later.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(rl.retryAfterSeconds ?? 60),
        'X-RateLimit-Limit': String(rl.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
      },
    }
  );
}
