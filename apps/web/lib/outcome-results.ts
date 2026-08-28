/**
 * Outcome result tokens and guards.
 *
 * Recovery results are distinguished by *how* they were confirmed so the
 * dashboards and analytics can be honest about the source:
 *   - RECOVERED                  provider-verified (webhook event / API poll)
 *   - ADMIN_CONFIRMED_RECOVERY   manually confirmed by an admin override
 *
 * Both count as money recovered; they are only ever displayed separately.
 */
export const OUTCOME_RECOVERED = 'RECOVERED';
export const OUTCOME_NOT_RECOVERED = 'NOT_RECOVERED';
export const OUTCOME_ADMIN_CONFIRMED = 'ADMIN_CONFIRMED_RECOVERY';

export function isRecoveredResult(result: string | null | undefined): boolean {
  return result === OUTCOME_RECOVERED || result === OUTCOME_ADMIN_CONFIRMED;
}

export function isAdminConfirmedResult(result: string | null | undefined): boolean {
  return result === OUTCOME_ADMIN_CONFIRMED;
}