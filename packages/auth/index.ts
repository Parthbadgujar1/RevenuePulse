/**
 * Authentication Module
 *
 * Email/password with Prisma-backed user persistence (User table).
 * bcryptjs for password hashing (cost 12).
 * NextAuth.js JWT sessions carrying role/merchantId tenant claims.
 * RBAC helpers exported for route-level permission checks.
 */
import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import type { NextAuthOptions } from "next-auth";
import { prisma } from "@rp/database";

export type UserRole =
  | 'MERCHANT_OWNER'
  | 'FINANCE_MANAGER'
  | 'SUPPORT_OPERATOR'
  | 'ADMIN';

const DEMO_OWNER_EMAIL = 'owner@revenuepulse.dev';
const DEMO_OWNER_PASSWORD = 'demo1234';

async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Ensure the demo merchant + owner account exist so local sign-in works
 * without a registration flow. Non-production only; lazily invoked from
 * authorize() so a fresh/reset database self-heals on first login attempt.
 */
async function ensureDemoOwner(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  try {
    const merchant = await prisma.merchant.upsert({
      where: { id: 'demo-merchant' },
      update: {},
      create: {
        id: 'demo-merchant',
        name: 'Demo Merchant',
        currency: 'INR',
        createdAt: new Date(),
      },
    });
    const existing = await prisma.user.findUnique({
      where: { email: DEMO_OWNER_EMAIL },
    });
    if (!existing) {
      await prisma.user.create({
        data: {
          name: 'Demo Owner',
          email: DEMO_OWNER_EMAIL,
          passwordHash: await hashPassword(DEMO_OWNER_PASSWORD),
          role: 'MERCHANT_OWNER',
          status: 'active',
          merchantId: merchant.id,
          createdAt: new Date(),
        },
      });
    }
  } catch {
    // Database may be briefly unavailable during startup; authorize() will
    // surface a real error when a genuine login is attempted.
  }
}

/**
 * RBAC permissions by role
 */
const rolePermissions: Record<UserRole, string[]> = {
  MERCHANT_OWNER: [
    'dashboard:view',
    'policies:configure',
    'actions:approve',
    'integrations:manage',
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

/** Check a role against a required permission string. */
export function hasPermission(role: string | null | undefined, permission: string): boolean {
  if (!role) return false;
  return (rolePermissions[role as UserRole] || []).includes(permission);
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
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        await ensureDemoOwner();

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user || !user.passwordHash) {
          // Same message for unknown user and missing credential to avoid
          // leaking account existence.
          throw new Error('Invalid email or password');
        }
        if (user.status !== 'active') {
          throw new Error('Account is not active');
        }

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) {
          throw new Error('Invalid email or password');
        }

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
  session: {
    strategy: 'jwt' as const,
    maxAge: 8 * 60 * 60, // 8h working-day sessions
  },
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
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NODE_ENV === 'development',
};

/**
 * Next.js route handlers for /api/auth/[...nextauth]
 */
const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };

/**
 * Registration - persists the user to the database.
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
  role: UserRole,
  merchantId?: string
) {
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    throw new Error('User with this email already exists');
  }

  return prisma.user.create({
    data: {
      name,
      email: normalized,
      passwordHash: await hashPassword(password),
      role,
      status: 'active',
      merchantId,
      createdAt: new Date(),
    },
    select: { id: true, email: true, name: true, role: true, merchantId: true },
  });
}

// ---------------------------------------------------------------------------
// Password reset flow (S1.2)
//
// Tokens are stored hashed (sha256); the raw token exists only at issue time.
// Default TTL 1 hour, single use.
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Create a password-reset token for the given email.
 * Returns the RAW token (caller must deliver it via email) or null when the
 * account does not exist — callers should respond identically either way to
 * avoid account enumeration.
 */
export async function createPasswordResetToken(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user) return null;

  // Invalidate any outstanding tokens for this user (single active flow).
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

  const raw = randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return raw;
}

/**
 * Consume a reset token and set the new password.
 * Throws on invalid/expired/used tokens.
 */
export async function resetPasswordWithToken(raw: string, newPassword: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(raw) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new Error('Invalid or expired reset token');
  }
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);
}
