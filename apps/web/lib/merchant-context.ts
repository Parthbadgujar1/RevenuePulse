import { getServerSession } from 'next-auth';
import { authOptions, hasPermission } from '@rp/auth';
import { prisma, ensureDemoMerchant } from '@rp/database';

export interface MerchantContext {
  userId: string;
  email?: string | null;
  role: string;
  merchantId: string;
  /** true when no session exists and we fell back to the single demo tenant */
  demoFallback: boolean;
}

/** Thrown when no session exists and the demo fallback is disabled. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'AuthRequiredError';
  }
}

/** Thrown when the authenticated role lacks the required permission (403). */
export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = 'ForbiddenError';
  }
}

/** HTTP status for an API catch-all: 401 for auth failures, else 500. */
export function apiErrorStatus(err: unknown): number {
  if (err instanceof AuthRequiredError) return 401;
  if (err instanceof ForbiddenError) return 403;
  return 500;
}

/**
 * RBAC gate: require that the session role holds `permission`, else 403.
 * In demo fallback mode the caller role defaults to MERCHANT_OWNER (the
 * richest merchant role) so interactive demos are not blocked.
 */
export function requirePermission(ctx: Pick<MerchantContext, 'role'>, permission: string): void {
  if (!hasPermission(ctx.role, permission)) {
    throw new ForbiddenError(permission);
  }
}

/**
 * Demo fallback policy:
 * - dev/test (NODE_ENV !== 'production'): enabled unless RP_DEMO_FALLBACK=0
 * - production: DISABLED by default — fail closed. Set RP_DEMO_FALLBACK=1
 *   explicitly to run a public demo tenant.
 */
function demoFallbackEnabled(): boolean {
  const flag = process.env.RP_DEMO_FALLBACK;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Central authorization context for every protected API route and page.
 *
 * Session user -> merchantId, so ALL downstream Prisma queries can be
 * merchant-scoped (no global findMany leaks across tenants).
 *
 * When no session exists we fall back to the single seeded demo merchant
 * for local dev/smoke tests — but ONLY while demoFallbackEnabled() allows
 * it. Otherwise AuthRequiredError is thrown (fail closed).
 */
export async function requireMerchantContext(): Promise<MerchantContext> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { id?: string; email?: string | null; role?: string; merchantId?: string }
    | undefined;

  if (user?.merchantId) {
    return {
      userId: user.id ?? 'unknown',
      email: user.email,
      role: user.role ?? 'MERCHANT_OWNER',
      merchantId: user.merchantId,
      demoFallback: false,
    };
  }

  if (!demoFallbackEnabled()) {
    throw new AuthRequiredError();
  }

  // Demo fallback tenant (documented above)
  const merchantId = await ensureDemoMerchant(prisma);
  return {
    userId: user?.id ?? 'anonymous',
    email: user?.email,
    role: user?.role ?? 'MERCHANT_OWNER',
    merchantId,
    demoFallback: true,
  };
}

/** Wrap an API handler with merchant-context + uniform 401/500 handling. */
export function withMerchantContext<T>(
  handler: (ctx: MerchantContext, req: Request) => Promise<T>
) {
  return async (req: Request): Promise<Response> => {
    try {
      const ctx = await requireMerchantContext();
      const data = await handler(ctx, req);
      return Response.json(data);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return Response.json({ error: err.message }, { status: 401 });
      }
      console.error('[api] handler error:', err);
      return Response.json(
        { error: (err as Error).message ?? 'Internal error' },
        { status: 500 }
      );
    }
  };
}
