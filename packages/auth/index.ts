/**
 * Authentication Module
 *
 * Email/password only for MVP.
 * Uses bcrypt for password hashing.
 * NextAuth.js for session management.
 * RBAC enforced via middleware.
 */

import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import type { NextAuthOptions } from "next-auth";

// In-memory user store for MVP; swap for Prisma lookups in production.
interface AppUser {
  id: string;
  name?: string;
  email: string;
  passwordHash: string;
  role: 'MERCHANT_OWNER' | 'FINANCE_MANAGER' | 'SUPPORT_OPERATOR' | 'ADMIN';
  merchantId?: string;
}

const users: AppUser[] = [];

// Dev/demo bootstrap - seed a demo merchant owner so local sign-in works
// without a registration flow. No-op in production.
if (process.env.NODE_ENV !== 'production') {
  void (async () => {
    users.push({
      id: 'user_demo_owner',
      name: 'Demo Owner',
      email: 'owner@revenuepulse.dev',
      passwordHash: await hashPassword('demo1234'),
      role: 'MERCHANT_OWNER',
      merchantId: 'demo-merchant',
    });
  })();
}

/**
 * Hash password using bcrypt
 */
async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

/**
 * RBAC permissions by role
 */
const rolePermissions: Record<string, string[]> = {
  MERCHANT_OWNER: [
    'dashboard:view',
    'policies:configure',
    'actions:approve',
    'analytics:view',
    'audit:view',
    'users:manage',
  ],
  FINANCE_MANAGER: [
    'dashboard:view',
    'recovery:cases:view',
    'actions:approve:financial',
    'analytics:view',
    'audit:view',
  ],
  SUPPORT_OPERATOR: [
    'dashboard:view',
    'recovery:cases:view',
    'actions:handle',
    'customers:view',
    'audit:view',
  ],
  ADMIN: [
    'dashboard:view',
    'system:configure',
    'integrations:manage',
    'users:view',
    'audit:manage',
  ],
};

/**
 * Check if a user has a specific permission
 */
function hasPermission(user: { role?: string } | null | undefined, permission: string): boolean {
  if (!user || !user.role) return false;
  const permissions = rolePermissions[user.role] || [];
  return permissions.includes(permission);
}

export const authOptions: NextAuthOptions = {
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email', placeholder: 'example@merchant.com' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        // Find user by email
        const user = users.find((u) => u.email === email);

        if (!user) {
          throw new Error('No user found with this email');
        }

        // Verify password
        const isValid = await verifyPassword(password, user.passwordHash);

        if (!isValid) {
          throw new Error('Invalid password');
        }

        // Return user object (stored into JWT via callbacks)
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          role: user.role,
          merchantId: user.merchantId ?? null,
        };
      },
    }),
  ],
  // Session strategy: JWT for stateless auth
  session: {
    strategy: 'jwt' as const,
  },
  // Callbacks to propagate role/tenant claims into token + session
  callbacks: {
    async jwt({ token, user }) {
      const u = user as unknown as { role?: string; merchantId?: string } | undefined;
      if (u) {
        (token as { role?: string }).role = u.role;
        (token as { merchantId?: string }).merchantId = u.merchantId;
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as { role?: string; merchantId?: string };
      const s = session.user as { role?: string; merchantId?: string } & typeof session.user;
      s.role = t.role;
      s.merchantId = t.merchantId;
      return session;
    },
  },
  // Secret for JWT signing - must be provided via environment variables
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NODE_ENV === 'development',
};

/**
 * Next.js route handlers for /api/auth/[...nextauth]
 */
const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };

/**
 * Middleware for permission checking.
 * Wraps a route handler and enforces RBAC before invoking it.
 * Usage: `export const POST = withPermission('actions:approve')(handler)`
 */
function withPermission(
  permission: string,
  routeHandler: (req: Request, user: AppUser) => Promise<Response>
) {
  return async (req: Request): Promise<Response> => {
    const session = await getSession();

    if (!session?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!hasPermission(session.user as { role?: string }, permission)) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return routeHandler(req, session.user as unknown as AppUser);
  };
}

/**
 * Get the current session from the request.
 * Placeholder until NextAuth server-session wiring is added per-route.
 */
async function getSession(): Promise<{ user: unknown } | null> {
  // NextAuth manages sessions through its own handlers; routes should use getServerSession.
  return null;
}

/**
 * Registration function - called when creating a new user
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
  role: 'MERCHANT_OWNER' | 'FINANCE_MANAGER' | 'SUPPORT_OPERATOR' | 'ADMIN',
  merchantId?: string
) {
  if (users.find((u) => u.email === email)) {
    throw new Error('User with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const user: AppUser = {
    id: `user_${Date.now()}`,
    name,
    email,
    passwordHash,
    role,
    merchantId,
  };

  users.push(user);
  return user;
}
