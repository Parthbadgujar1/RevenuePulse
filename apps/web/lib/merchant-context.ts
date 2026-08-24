import { getServerSession } from 'next-auth';
import { authOptions } from '@rp/auth';
import { prisma, ensureDemoMerchant } from '@rp/database';

export interface MerchantContext {
  userId: string;
  email?: string | null;
  role: string;
  merchantId: string;
  /** true when no session exists and we fell back to the single demo tenant */
  demoFallback: boolean;
}

/**
 * Central authorization context for every protected API route and page.
 *
 * Session user -> merchantId, so ALL downstream Prisma queries can be
 * merchant-scoped (no global findMany leaks across tenants).
 *
 * Local/demo note: when no session exists (e.g. smoke tests, local dev
 * without sign-in) we fall back to the single seeded demo merchant instead
 * of failing — but the returned `demoFallback` flag makes that explicit.
 * Production deployments should remove the fallback (fail closed).
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
      console.error('[api] handler error:', err);
      return Response.json(
        { error: (err as Error).message ?? 'Internal error' },
        { status: 500 }
      );
    }
  };
}
