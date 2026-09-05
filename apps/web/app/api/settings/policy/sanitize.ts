/**
 * Shared policy-input validation. Whitelist + range-check every field —
 * never trust client JSON blindly. Used by both the save endpoint (PUT
 * /api/settings/policy) and the read-only what-if simulator (POST
 * /api/settings/policy/simulate) so a "valid to preview" policy is always
 * exactly "valid to save".
 */
import { DEFAULT_MERCHANT_POLICY } from '@rp/policies';
import type { MerchantPolicy } from '@rp/policies';

export const VALID_INTERVENTIONS = [
  'retry_later',
  'timed_reminder',
  'payment_method_recovery',
  'checkout_recovery',
  'subscription_recovery',
  'human_escalation',
  'do_nothing',
];

export function sanitizePolicy(input: any): { policy: Partial<MerchantPolicy>; errors: string[] } {
  const errors: string[] = [];
  const policy: Partial<MerchantPolicy> = {};
  const num = (
    key: keyof MerchantPolicy,
    min: number,
    max: number,
    integer = false
  ) => {
    if (!input || !(key in input)) return;
    let v = Number(input[key]);
    if (!Number.isFinite(v)) {
      errors.push(`${key} must be a number`);
      return;
    }
    if (integer) v = Math.floor(v);
    if (v < min || v > max) {
      errors.push(`${key} must be between ${min} and ${max}`);
      return;
    }
    (policy as Record<string, unknown>)[key] = v;
  };
  const bool = (key: keyof MerchantPolicy) => {
    if (!input || !(key in input)) return;
    if (typeof input[key] !== 'boolean') {
      errors.push(`${key} must be boolean`);
      return;
    }
    (policy as Record<string, unknown>)[key] = input[key];
  };

  if (!input || typeof input !== 'object') {
    return { policy, errors };
  }

  bool('autoActionEnable');
  bool('stopOnCustomerDecline');
  bool('stopOnRepeatedFailure');
  bool('stopOnPolicyViolation');

  num('maximumIncentivePercentage', 0, 100);
  num('maximumIncentiveAmount', 0, 100_000_000);
  num('maximumRecoveryValue', 0, 100_000_000);
  num('maximumRetryCount', 0, 10, true);
  num('maximumContactCount', 0, 10, true);
  num('minimumRecoveryProbability', 0.01, 1);
  num('minimumExpectedNetRecovery', 0, 10_000_000);
  num('humanApprovalThreshold', 0, 100_000_000);
  num('cooldownPeriod', 0, 720);
  num('maximumCaseLifetime', 1, 365, true);

  if ('allowedInterventionTypes' in input) {
    if (
      !Array.isArray(input.allowedInterventionTypes) ||
      input.allowedInterventionTypes.some((t: unknown) => !VALID_INTERVENTIONS.includes(String(t)))
    ) {
      errors.push(`allowedInterventionTypes must be a subset of: ${VALID_INTERVENTIONS.join(', ')}`);
    } else {
      policy.allowedInterventionTypes = input.allowedInterventionTypes as MerchantPolicy['allowedInterventionTypes'];
    }
  }

  const allowed = [
    'autoActionEnable',
    'stopOnCustomerDecline',
    'stopOnRepeatedFailure',
    'stopOnPolicyViolation',
    'maximumIncentivePercentage',
    'maximumIncentiveAmount',
    'maximumRecoveryValue',
    'maximumRetryCount',
    'maximumContactCount',
    'minimumRecoveryProbability',
    'minimumExpectedNetRecovery',
    'humanApprovalThreshold',
    'cooldownPeriod',
    'maximumCaseLifetime',
    'allowedInterventionTypes',
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`Unknown policy field "${key}"`);
  }
  return { policy, errors };
}

export { DEFAULT_MERCHANT_POLICY };
