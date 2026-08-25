/**
 * Next.js instrumentation hooks (runs once per server instance).
 *
 * Node-only background work lives in lib/outcome-poller.ts and is imported
 * dynamically behind the NEXT_RUNTIME guard so the Edge instrumentation
 * bundle never pulls Node-only modules (crypto, pg).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateProductionEnv } = await import('./lib/env');
    const problems = validateProductionEnv();
    if (problems.length > 0) {
      // Fail fast: refuse to serve traffic with a misconfigured deployment.
      throw new Error(
        `Production environment validation failed:\n- ${problems.join('\n- ')}`
      );
    }

    const { startOutcomePoller } = await import('./lib/outcome-poller');
    startOutcomePoller();
  }
}
