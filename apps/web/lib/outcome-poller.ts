/**
 * Background live-outcome poller (Node.js runtime only).
 *
 * Every RP_VERIFY_POLL_SECONDS (default 300; 0 disables) ask Razorpay for the
 * real status of payments behind OUTCOME_PENDING cases and resolve honestly:
 * captured -> RECOVERED, failed/cancelled -> NOT_RECOVERED, nothing
 * fabricated. Merchants without configured credentials are skipped quietly.
 */
export function startOutcomePoller(): void {
  const seconds = parseInt(process.env.RP_VERIFY_POLL_SECONDS ?? '300', 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  // Survive dev-mode HMR re-registration
  const g = globalThis as any;
  if (g.__rpVerifyPollerStarted) return;
  g.__rpVerifyPollerStarted = true;

  let credsWarned = false;

  async function tick() {
    try {
      const { verifyPendingLiveOutcomes } = await import('./outcome-verifier');
      const summary = await verifyPendingLiveOutcomes({});
      if ((summary.checked ?? 0) > 0) {
        console.log(
          `[outcome-poller] checked ${summary.checked}: ${summary.recovered} recovered, ${summary.notRecovered} not recovered`
        );
      } else if (summary.skipped?.some((s) => s.includes('(401)'))) {
        if (!credsWarned) {
          console.warn('[outcome-poller] stored Razorpay credentials rejected — reconnect on /integrations');
          credsWarned = true;
        }
      }
    } catch (err) {
      console.error('[outcome-poller] failed:', (err as Error).message);
    }
  }

  // First pass shortly after boot (DB may still be settling), then interval.
  setTimeout(() => void tick(), 10_000);
  const handle = setInterval(() => void tick(), seconds * 1000);
  if (typeof handle.unref === 'function') handle.unref();

  console.log(`[outcome-poller] live-outcome verification every ${seconds}s`);
}
