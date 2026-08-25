/**
 * Classify a real Razorpay payment status into the recovery-outcome bucket.
 * Pure function — no DB/network — so the honest resolution semantics are
 * unit-testable.
 *
 *  captured            -> recovered   (money actually came back)
 *  failed | cancelled  -> not_recovered (terminal provider failure)
 *  anything else       -> pending     (authorized/refunded/created/unknown:
 *                                      keep OUTCOME_PENDING, never fabricate)
 */
export type ProviderOutcomeClass = 'recovered' | 'not_recovered' | 'pending';

export function classifyProviderPaymentStatus(status: unknown): ProviderOutcomeClass {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (s === 'captured') return 'recovered';
  if (s === 'failed' || s === 'cancelled') return 'not_recovered';
  return 'pending';
}
