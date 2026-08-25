/**
 * Next.js instrumentation hooks (runs once per server instance).
 *
 * Node-only background work lives in lib/outcome-poller.ts and is imported
 * dynamically behind the NEXT_RUNTIME guard so the Edge instrumentation
 * bundle never pulls Node-only modules (crypto, pg).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOutcomePoller } = await import('./lib/outcome-poller');
    startOutcomePoller();
  }
}
