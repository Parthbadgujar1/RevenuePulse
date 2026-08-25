/**
 * Environment validation - fail fast on misconfiguration.
 *
 * Production requires explicit secrets; development may use documented
 * fallbacks so local setup stays friction-free.
 */

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export class MissingEnvError extends Error {
  constructor(keys: string[]) {
    super(
      `Missing required environment variable(s): ${keys.join(', ')}. ` +
        'Set them before starting the server.'
    );
    this.name = 'MissingEnvError';
  }
}

/**
 * Return the app-level secret used for JWT signing + secret encryption.
 * Throws in production when unset; falls back to a dev-only value otherwise.
 */
export function getAppSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.RP_SECRET;
  if (!secret) {
    if (isProduction()) {
      throw new MissingEnvError(['NEXTAUTH_SECRET', 'RP_SECRET']);
    }
    return 'revenuepulse-dev-only-secret';
  }
  return secret;
}

/**
 * Validate all environment variables required for production startup.
 * Returns the list of problems (empty array = OK).
 */
export function validateProductionEnv(): string[] {
  if (!isProduction()) return [];
  const problems: string[] = [];

  if (!process.env.NEXTAUTH_SECRET && !process.env.RP_SECRET) {
    problems.push('NEXTAUTH_SECRET or RP_SECRET must be set');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL must be set');
  }
  if (!process.env.ML_SERVICE_URL) {
    problems.push('ML_SERVICE_URL must be set');
  }

  // Demo-mode escape hatches must never be on by default in production.
  if (
    process.env.RP_DEMO_FALLBACK === '1' ||
    process.env.RAZORPAY_MODE === 'demo'
  ) {
    problems.push(
      'RP_DEMO_FALLBACK=1 / RAZORPAY_MODE=demo are not allowed in production'
    );
  }

  return problems;
}
