/**
 * Intervention effectiveness lifts - SINGLE SOURCE OF TRUTH.
 *
 * These lifts express how much each intervention type shifts the predicted
 * recovery probability, per failure category. They are calibrated against
 * published 2025-26 dunning benchmarks and MUST stay in sync with:
 *   - services/ml/data/generate_synthetic.py `_intervention_lift` (training data)
 *   - the demo ground-truth simulator (consumes via getInterventionLift)
 *   - the decision engine (argmax over effective probability)
 *
 * Importing from one module guarantees the engine's expectations and the
 * simulator's reality can never silently diverge.
 */
import { FailureCategory } from '../../domain/src/constants/failure-taxonomy';

export type InterventionActionType =
  | 'retry_later'
  | 'timed_reminder'
  | 'checkout_recovery'
  | 'subscription_recovery'
  | 'payment_method_recovery'
  | 'human_escalation';

/**
 * Lift table: actionType -> failureCategory -> probability delta.
 * The 'default' key applies to any category without a specific entry.
 */
export const INTERVENTION_LIFTS: Record<InterventionActionType, Partial<Record<FailureCategory | 'default', number>>> = {
  retry_later: {
    [FailureCategory.NETWORK_TIMEOUT]: 0.14,
    [FailureCategory.INSUFFICIENT_FUNDS]: 0.10,
    [FailureCategory.BANK_FAILURE]: 0.06,
    [FailureCategory.AUTH_FAILURE]: 0.06,
    [FailureCategory.EXPIRED_INSTRUMENT]: -0.18,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: -0.18,
    default: 0,
  },
  timed_reminder: {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0.07,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0.05,
    default: 0.01,
  },
  checkout_recovery: {
    [FailureCategory.AUTH_FAILURE]: 0.08,
    default: 0.04,
  },
  subscription_recovery: {
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0.09,
    default: 0.03,
  },
  payment_method_recovery: {
    [FailureCategory.EXPIRED_INSTRUMENT]: 0.24,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0.16,
    [FailureCategory.AUTH_FAILURE]: 0.08,
    default: -0.02,
  },
  human_escalation: {
    [FailureCategory.CUSTOMER_CANCELLATION]: -0.02,
    default: 0.06,
  },
};

/**
 * Look up the effectiveness lift for an intervention on a failure category.
 * Unknown actions return 0 (neutral) rather than throwing — the decision
 * engine treats unknown interventions as no-lift candidates.
 */
export function getInterventionLift(
  actionType: string,
  failureCategory: string
): number {
  const row = INTERVENTION_LIFTS[actionType as InterventionActionType];
  if (!row) return 0;
  const specific = row[failureCategory as FailureCategory];
  if (specific !== undefined) return specific;
  return row.default ?? 0;
}
