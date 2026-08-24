/**
 * Merchant recovery-policy settings.
 * GET  -> current effective policy (defaults merged with stored overrides)
 * PUT  -> validate + persist overrides under Merchant.settings.recoveryPolicy
 *
 * Stored policy is read by getMerchantPolicy() in the pipeline, so changes
 * apply to every new decision immediately — no redeploy needed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { DEFAULT_MERCHANT_POLICY } from '@rp/policies';
import type { MerchantPolicy } from '@rp/policies';
import { requireMerchantContext } from '../../../../lib/merchant-context';

const VALID_INTERVENTIONS = [
  'retry_later',
  'timed_reminder',
  'payment_method_recovery',
  'checkout_recovery',
  'subscription_recovery',
  'human_escalation',
  'do_nothing',
];

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Whitelist + range-check every field; never trust client JSON blindly. */
function sanitizePolicy(input: any): { policy: Partial<MerchantPolicy>; errors: string[] } {
  const errors: string[] = [];
  const d = DEFAULT_MERCHANT_POLICY;
  const policy: Partial<MerchantPolicy> = {};
  const num = (
    key: keyof MerchantPolicy,
    min: number,
    max: number,
    integer = false
  ) => {
    if (!(key in input)) return;
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
    if (!(key in input)) return;
    if (typeof input[key] !== 'boolean') {
      errors.push(`${key} must be boolean`);
      return;
    }
    (policy as Record<string, unknown>)[key] = input[key];
  };

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

export async function GET() {
  try {
    const { merchantId } = await requireMerchantContext();
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    const stored = ((merchant?.settings as Record<string, unknown>) ?? {}).recoveryPolicy as
      | Partial<MerchantPolicy>
      | undefined;
    return NextResponse.json({
      policy: { ...DEFAULT_MERCHANT_POLICY, ...(stored ?? {}) },
      defaults: DEFAULT_MERCHANT_POLICY,
      hasOverrides: Boolean(stored),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Failed to load policy' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Expected a JSON policy object' }, { status: 400 });
    }
    const { policy, errors } = sanitizePolicy(body);
    if (errors.length) {
      return NextResponse.json({ error: 'Invalid policy', details: errors }, { status: 422 });
    }

    const { merchantId } = await requireMerchantContext();
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    const settings = ((merchant?.settings as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const updatedSettings = { ...settings, recoveryPolicy: policy };

    await prisma.merchant.update({
      where: { id: merchantId },
      data: { settings: updatedSettings },
    });

    return NextResponse.json({
      ok: true,
      saved: policy,
      effectivePolicy: { ...DEFAULT_MERCHANT_POLICY, ...policy },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Failed to save policy' }, { status: 500 });
  }
}
