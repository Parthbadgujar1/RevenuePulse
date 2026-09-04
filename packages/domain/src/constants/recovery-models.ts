// Recovery Probability and Economic Models
// Transparent baseline models for recovery prediction

import { FailureCategory } from './failure-taxonomy';

// Features used in the baseline logistic regression model
export interface RecoveryFeatures {
  amount: number; // transaction amount in paise
  failureCategory: FailureCategory;
  paymentMethod: string; // e.g., "card", "upi", "netbanking"
  historicalSuccessRate: number; // customer's historical recovery rate (0-1)
  numberOfPreviousFailures: number;
  timeSinceFailureHours: number; // hours since the failure occurred
  transactionHour: number; // hour of day when failure occurred (0-23)
  retryCount: number; // number of prior recovery attempts
  isSubscription: boolean;
  merchantHistoricalRate: number; // merchant's overall recovery rate (0-1)
  failureCategoryHistoricalRate: number; // historical success for this failure type (0-1)
  amountPercentile: number; // percentile of amount for this merchant (0-1)
  // v4 context-aware features (optional, defaulted for legacy callers)
  intervention?: string; // recovery intervention applied
  contactChannel?: string; // outreach channel (email|sms|whatsapp|phone|none)
  merchantVertical?: string; // business vertical (saas|ecommerce|b2b|fintech|other)
  dayOfWeek?: number; // 0=Mon .. 6=Sun
  customerTenureDays?: number; // account age in days
  planTier?: number; // 0=basic,1=standard,2=premium
}

// Baseline model prediction result
export interface BaselinePrediction {
  modelVersion: string;
  recoveryProbability: number; // 0-1
  expectedRecoveryValue: number; // in paise = amount * probability
  confidence: number; // calibration confidence (0-1)
  featureWeights: Record<keyof RecoveryFeatures, number>; // SHAP-like contributions
  featureSnapshot: RecoveryFeatures;
}

// Economic calculation results
export interface EconomicCalculation {
  amount: number; // amount at risk in paise
  recoveryProbability: number; // 0-1
  expectedRecoveryValue: number; // in paise = amount * probability
  estimatedActionCost: number; // in paise (retries, incentives, etc.)
  expectedIncentiveCost: number; // in paise (if incentives involved)
  expectedNetRecovery: number; // in paise = expectedRecoveryValue - estimatedActionCost - expectedIncentiveCost
  customerFrictionRisk: number; // 0-1, estimated customer annoyance/risk
  policyEligible: boolean; // whether action passes policy checks
  priorityScore: number; // composite score for case prioritization
  recommendedAction: 'retry_later' | 'timed_reminder' | 'payment_method_recovery' |
                     'human_escalation' | 'do_nothing';
  reasoning: string; // human-readable explanation
}

// Structural shape of merchant policy configuration used for checks.
// MerchantPolicy in the policies package is structurally compatible.
export interface MerchantPolicyConfig {
  maximumIncentivePercentage: number;
  maximumIncentiveAmount: number; // in paise
  maximumRecoveryValue: number; // in paise
  maximumRetryCount: number;
  maximumContactCount: number;
  minimumRecoveryProbability: number; // 0-1
  minimumExpectedNetRecovery: number; // in paise
  humanApprovalThreshold: number; // in paise
  allowedInterventionTypes: string[];
  cooldownPeriod: number; // hours
  maximumCaseLifetime: number; // days
  stopOnCustomerDecline: boolean;
  stopOnRepeatedFailure: boolean;
  stopOnPolicyViolation: boolean;
  autoActionEnable: boolean;
}

// Policy guardrail result
export interface PolicyCheckResult {
  allowed: boolean;
  approvalRequired: boolean;
  violations: string[]; // list of policy violations, empty if allowed
  policySnapshot: {
    maximumIncentivePercentage: number;
    maximumIncentiveAmount: number;
    maximumRecoveryValue: number;
    maximumRetryCount: number;
    maximumContactCount: number;
    minimumRecoveryProbability: number;
    minimumExpectedNetRecovery: number;
    humanApprovalThreshold: number; // in paise
    allowedInterventionTypes: string[];
    cooldownPeriod: number; // hours
    maximumCaseLifetime: number; // days
    stopOnCustomerDecline: boolean;
    stopOnRepeatedFailure: boolean;
    stopOnPolicyViolation: boolean;
    autoActionEnable: boolean;
  };
}

// Intervention type definitions
export enum InterventionType {
  RETRY_LATER = 'retry_later',
  TIMED_REMINDER = 'timed_reminder',
  PAYMENT_METHOD_RECOVERY = 'payment_method_recovery',
  CHECKOUT_RECOVERY = 'checkout_recovery',
  SUBSCRIPTION_RECOVERY = 'subscription_recovery',
  HUMAN_ESCALATION = 'human_escalation',
  DO_NOTHING = 'do_nothing',
}

export interface InterventionDefinition {
  type: InterventionType;
  prerequisites: (ctx: {
    probability: number;
    amount: number;
    policy: MerchantPolicyConfig;
    features: RecoveryFeatures;
  }) => boolean;
  expectedCost: number; // in paise
  maxAttempts: number;
  cooldownHours: number;
  stoppingRules: 'none' | 'max_attempts' | 'customer_decline' | 'policy_block';
  description: string;
}

// Default intervention definitions
export const INTERVENTIONS: Record<InterventionType, InterventionDefinition> = {
  [InterventionType.RETRY_LATER]: {
    type: InterventionType.RETRY_LATER,
    prerequisites: (ctx) => ctx.probability >= 0.3 && ctx.amount >= 1000,
    expectedCost: 20, // minimal cost for a retry
    maxAttempts: 3,
    cooldownHours: 24,
    stoppingRules: 'max_attempts',
    description: 'Retry after transient failure cooldown',
  },
  [InterventionType.TIMED_REMINDER]: {
    type: InterventionType.TIMED_REMINDER,
    prerequisites: (ctx) => ctx.probability >= 0.5 && ctx.amount >= 5000,
    expectedCost: 50,
    maxAttempts: 1,
    cooldownHours: 48,
    stoppingRules: 'none',
    description: 'Send recovery reminder to customer',
  },
  [InterventionType.PAYMENT_METHOD_RECOVERY]: {
    type: InterventionType.PAYMENT_METHOD_RECOVERY,
    prerequisites: (ctx) => ctx.features.failureCategory === FailureCategory.EXPIRED_INSTRUMENT && ctx.probability >= 0.4,
    expectedCost: 100,
    maxAttempts: 2,
    cooldownHours: 72,
    stoppingRules: 'max_attempts',
    description: 'Update payment method for expired card',
  },
  [InterventionType.CHECKOUT_RECOVERY]: {
    type: InterventionType.CHECKOUT_RECOVERY,
    // Checkout recovery targets abandoned one-time checkouts (not subscription
    // renewals). It is not a generic auto-retry: it is scheduled by the
    // dedicated checkout-recovery path (JobType.CHECKOUT_RECOVERY), so the
    // generic DecisionEngine only considers it for non-subscription cases with
    // meaningful value and a realistic chance to convert.
    prerequisites: (ctx) => !ctx.features.isSubscription && ctx.probability >= 0.2 && ctx.amount >= 5000,
    expectedCost: 75,
    maxAttempts: 1,
    cooldownHours: 0,
    stoppingRules: 'none',
    description: 'Checkout recovery task',
  },
  [InterventionType.SUBSCRIPTION_RECOVERY]: {
    type: InterventionType.SUBSCRIPTION_RECOVERY,
    prerequisites: (ctx) => ctx.features.isSubscription && ctx.probability >= 0.25,
    expectedCost: 150,
    maxAttempts: 5,
    cooldownHours: 168,
    stoppingRules: 'max_attempts',
    description: 'Subscription recovery for recurring payment failures',
  },
  [InterventionType.HUMAN_ESCALATION]: {
    type: InterventionType.HUMAN_ESCALATION,
    prerequisites: (ctx) => ctx.amount >= 10000 && ctx.probability >= 0.6,
    expectedCost: 500, // cost of human time
    maxAttempts: 1,
    cooldownHours: 0,
    stoppingRules: 'none',
    description: 'Human escalation for high-value cases',
  },
  [InterventionType.DO_NOTHING]: {
    type: InterventionType.DO_NOTHING,
    prerequisites: (ctx) => true,
    expectedCost: 0,
    maxAttempts: 0,
    cooldownHours: 0,
    stoppingRules: 'none',
    description: 'Do nothing - uneconomic or low-confidence case',
  },
};