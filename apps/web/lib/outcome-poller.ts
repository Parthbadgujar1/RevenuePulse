/**
 * Background live-outcome poller (Node.js runtime only).
 *
 * Every RP_VERIFY_POLL_SECONDS (default 300; 0 disables):
 *  1. Ask Razorpay for the real status of payments behind OUTCOME_PENDING cases
 *     and resolve honestly: captured -> RECOVERED, failed/cancelled ->
 *     NOT_RECOVERED, nothing fabricated.
 *  2. Sweep any OUTCOME_PENDING case older than RP_OUTCOME_TIMEOUT_DAYS
 *     (default 7) and mark it FAILED with stoppedReason=verification_timeout
 *     so it doesn't remain in limbo forever.
 */
export function startOutcomePoller(): void {
  const seconds = parseInt(process.env.RP_VERIFY_POLL_SECONDS ?? '300', 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  const g = globalThis as any;
  if (g.__rpVerifyPollerStarted) return;
  g.__rpVerifyPollerStarted = true;

  let credsWarned = false;
  const timeoutDays = Math.max(1, parseInt(process.env.RP_OUTCOME_TIMEOUT_DAYS ?? '7', 10) || 7);

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

      // Sweep stale OUTCOME_PENDING cases (stuck with no provider result)
      const { sweepStalePendingCases } = await import('./outcome-timeout');
      const swept = await sweepStalePendingCases(timeoutDays);
      if (swept > 0) {
        console.log(`[outcome-poller] swept ${swept} OUTCOME_PENDING case(s) older than ${timeoutDays}d -> verification_timeout`);
      }
    } catch (err) {
      console.error('[outcome-poller] failed:', (err as Error).message);
    }
  }

  setTimeout(() => void tick(), 10_000);
  const handle = setInterval(() => void tick(), seconds * 1000);
  if (typeof handle.unref === 'function') handle.unref();

  console.log(`[outcome-poller] live-outcome verification every ${seconds}s, timeout sweep ${timeoutDays}d`);
}
