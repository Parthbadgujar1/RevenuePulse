// Domain Services - Pure business logic functions
// These operate on structured data and are testing-friendly
// They do NOT contain any LLM calls or arbitrary API access

import {
  FailureCategory,
  Diagnosis,
  DiagnosisEvidence,
  TRANSIENT_CATEGORIES,
  PERMANENT_CATEGORIES,
} from '../constants/failure-taxonomy';
import {
  RecoveryFeatures,
  BaselinePrediction,
  EconomicCalculation,
  PolicyCheckResult,
  MerchantPolicyConfig,
  InterventionType,
  InterventionDefinition,
  INTERVENTIONS,
} from '../constants/recovery-models';

// Calculate recovery probability using baseline model
// This is a transparent baseline - not a black-box LLM
export function calculateRecoveryProbability(
  features: RecoveryFeatures
): BaselinePrediction {
  // Transparent baseline: logistic regression with interpretable features
  // Recovery probability = sigmoid(feature linear combination)

  // Feature weights (learned from data, exposed for inspection)
  const weights: Record<keyof RecoveryFeatures, number> = {
    amount: 0.00002, // larger amounts slightly increase probability (more at stake)
    failureCategory: 0, // handled via category adjustments below
    paymentMethod: 0,
    historicalSuccessRate: 0.4, // strong positive predictor
    numberOfPreviousFailures: -0.1, // each additional failure reduces probability
    timeSinceFailureHours: -0.02, // older failures slightly less recoverable
    transactionHour: 0,
    retryCount: -0.05, // each retry reduces confidence
    isSubscription: 0.15, // subscription failures have slightly higher recovery
    merchantHistoricalRate: 0.35, // strong positive predictor
    failureCategoryHistoricalRate: 0.3,
    amountPercentile: 0.05,
    // v4 context features (heuristic fallback: neutral defaults)
    intervention: 0, // handled via intervention lift table
    contactChannel: 0.02, // richer channels (whatsapp/phone) slightly better
    merchantVertical: 0.02, // B2B/SaaS accounts slightly stickier
    dayOfWeek: 0.01, // midweek/payday window lift
    customerTenureDays: 0.001, // established accounts slightly better
    planTier: 0.05, // premium plans get white-glove handling
  };

  // Category adjustments to base probability
  const categoryAdjustments: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0.15,
    [FailureCategory.BANK_FAILURE]: 0.10,
    [FailureCategory.AUTH_FAILURE]: 0.20,
    [FailureCategory.EXPIRED_INSTRUMENT]: -0.10,
    [FailureCategory.NETWORK_TIMEOUT]: 0.10,
    [FailureCategory.CUSTOMER_CANCELLATION]: -0.20,
    [FailureCategory.UNKNOWN]: 0.05,
    [FailureCategory.REPEATED_FAILURE]: -0.15,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0.05,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0.10,
  };

  // Calculate base logit
  let logit = 0;
  logit += weights.historicalSuccessRate * features.historicalSuccessRate;
  logit += weights.merchantHistoricalRate * features.merchantHistoricalRate;
  logit += weights.failureCategoryHistoricalRate * features.failureCategoryHistoricalRate;

  // Add category adjustment
  logit += (categoryAdjustments[features.failureCategory] || 0);

  // Add individual feature contributions
  logit += weights.amount * Math.log(features.amount + 1) / 1000; // log-scaled amount
  logit += weights.numberOfPreviousFailures * features.numberOfPreviousFailures;
  logit += weights.timeSinceFailureHours * features.timeSinceFailureHours / 24; // per day
  logit += weights.retryCount * features.retryCount;
  logit += weights.isSubscription * (features.isSubscription ? 1 : 0);
  logit += weights.amountPercentile * features.amountPercentile;

  // v4 context features (defaulted so legacy callers contribute nothing)
  logit += weights.customerTenureDays * Math.log1p(features.customerTenureDays ?? 0) / 100;
  logit += weights.planTier * (features.planTier ?? 0);
  logit += weights.dayOfWeek * ((features.dayOfWeek ?? 3) - 3) / 10;
  logit += weights.contactChannel * ((features.contactChannel === 'phone' || features.contactChannel === 'whatsapp') ? 1 : 0);
  logit += weights.merchantVertical * ((features.merchantVertical === 'saas' || features.merchantVertical === 'b2b') ? 1 : 0);
  logit += weights.intervention * (features.intervention ? 0 : 0); // lift applied by engine

  // Sigmoid: probability = 1 / (1 + e^-logit)
  const probability = 1 / (1 + Math.exp(-logit));
  const calibratedProbability = Math.min(Math.max(probability, 0.01), 0.99); // clamp 1-99%

  // Expected recovery value
  const expectedRecoveryValue = Math.floor(features.amount * calibratedProbability);

  // Confidence based on feature completeness and historical calibration
  const confidence = Math.min(0.9, 0.5 + 0.05 * features.historicalSuccessRate + 0.05 * features.merchantHistoricalRate);

  // Feature contributions (simplified SHAP-like)
  const featureContributions: Record<string, number> = {};
  for (const [key, weight] of Object.entries(weights)) {
    const value = (features as any)[key];
    if (value !== undefined && value !== null) {
      featureContributions[key] = weight * (value as number);
    }
  }

  return {
    modelVersion: 'baseline-v1.0.0',
    recoveryProbability: calibratedProbability,
    expectedRecoveryValue,
    confidence,
    featureWeights: weights,
    featureSnapshot: features,
  };
}

// Calculate economic decision
export function calculateEconomics(
  amount: number,
  probability: number,
  actionCost: number,
  incentiveCost: number = 0
): EconomicCalculation {
  const expectedRecoveryValue = Math.floor(amount * probability);
  const netRecovery = expectedRecoveryValue - actionCost - incentiveCost;
  const customerFrictionRisk = probability < 0.2 ? 0.8 : probability < 0.5 ? 0.5 : 0.2;
  const policyEligible = netRecovery > 0 && probability >= 0.2;

  // Determine priority and recommended action
  let priorityScore = Math.floor(
    (probability * 100) + 
    (amount / 1000) - 
    (actionCost / 10) -
    (incentiveCost / 10)
  );

  // Normalize priority to a reasonable range
  priorityScore = Math.max(0, Math.min(1000, priorityScore));

  // Determine recommended action based on policy and economics
  let recommendedAction: InterventionType = InterventionType.DO_NOTHING;
  let reasoning = '';

  if (!policyEligible) {
    recommendedAction = InterventionType.DO_NOTHING;
    reasoning = `Action blocked by merchant policy. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%.`;
  } else if (probability >= 0.8 && amount >= 20000) {
    recommendedAction = InterventionType.HUMAN_ESCALATION;
    reasoning = `High-value high-probability case. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%. Human approval required.`;
  } else if (probability >= 0.6 && amount >= 10000) {
    recommendedAction = InterventionType.HUMAN_ESCALATION;
    reasoning = `Moderate-value moderate-probability case. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%. Human approval recommended.`;
  } else if (probability >= 0.5 && policyEligible) {
    recommendedAction = InterventionType.RETRY_LATER;
    reasoning = `Positive expected net recovery. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%, Expected Net: ₹${(netRecovery/100).toLocaleString()}. Retry permitted.`;
  } else if (probability >= 0.3 && policyEligible) {
    recommendedAction = InterventionType.RETRY_LATER;
    reasoning = `Low-moderate probability within policy limits. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%, Expected Net: ₹${(netRecovery/100).toLocaleString()}. Retry permitted.`;
  } else {
    recommendedAction = InterventionType.DO_NOTHING;
    reasoning = `Low probability or negative expected value. Amount: ₹${(amount/100).toLocaleString()}, Probability: ${(probability*100).toFixed(1)}%, Expected Net: ₹${(netRecovery/100).toLocaleString()}. Do nothing.`;
  }

  return {
    amount,
    recoveryProbability: probability,
    expectedRecoveryValue,
    estimatedActionCost: actionCost,
    expectedIncentiveCost: incentiveCost,
    expectedNetRecovery: netRecovery,
    customerFrictionRisk,
    policyEligible,
    priorityScore,
    recommendedAction,
    reasoning,
  };
}

// Get intervention definition based on type
export function getInterventionDefinition(
  type: InterventionType
): InterventionDefinition | undefined {
  return INTERVENTIONS[type];
}

// Check if intervention is allowed given policy and context
export function isInterventionAllowed(
  type: InterventionType,
  policy: MerchantPolicyConfig,
  features: RecoveryFeatures
): { allowed: boolean; reason: string } {
  const definition = INTERVENTIONS[type];
  if (!definition) {
    return { allowed: false, reason: 'Unknown intervention type' };
  }

  // Default probability until an actual prediction is available
  const probability = 0.5;

  const prerequisitesMet = definition.prerequisites({
    probability,
    amount: features.amount,
    policy,
    features,
  });

  if (!prerequisitesMet) {
    return { allowed: false, reason: 'Prerequisites not met for this intervention' };
  }

  // Check minimum recovery probability
  if (probability < policy.minimumRecoveryProbability) {
    return { allowed: false, reason: 'Recovery probability below minimum threshold' };
  }
  // Check minimum expected net recovery
  const economics = calculateEconomics(
    features.amount,
    0.5, // use default probability
    definition.expectedCost,
    0 // no incentive for policy check
  );

  if (economics.expectedNetRecovery < policy.minimumExpectedNetRecovery) {
    return { allowed: false, reason: 'Expected net recovery below minimum threshold' };
  }

  // Check maximum limits
  if (features.amount > policy.maximumRecoveryValue) {
    return { allowed: false, reason: 'Recovery value exceeds merchant maximum' };
  }

  return { allowed: true, reason: 'Intervention allowed within policy' };
}

// Diagnose failure category from transaction data
// This is deterministic - no LLM dependency
export function diagnoseFailure(
  failureCode: string,
  failureMessage: string,
  providerErrorCategory?: string
): Diagnosis {
  // Normalize raw provider events into structured categories
  const categories: FailureCategory[] = [];
  const evidence: DiagnosisEvidence = {
    failureCodes: [failureCode || 'unknown'],
    categories: [],
    timeWindow: { start: 0, end: 23 },
    affectedPaymentMethods: [],
    affectedCustomerSegments: [],
    historicalRecoveryRates: {} as Record<FailureCategory, number>,
  };

  // Map common Razorpay/error codes to categories
  const codeLower = (failureCode || '').toLowerCase();
  const messageLower = (failureMessage || '').toLowerCase();

  // Pattern matching for failure categorization
  if (
    codeLower.includes('insufficient') ||
    codeLower.includes('balance') ||
    codeLower.includes('fund')
  ) {
    categories.push(FailureCategory.INSUFFICIENT_FUNDS);
    evidence.categories.push(FailureCategory.INSUFFICIENT_FUNDS);
  }

  if (
    codeLower.includes('bank') ||
    codeLower.includes('rb') ||
    codeLower.includes('reserve')
  ) {
    categories.push(FailureCategory.BANK_FAILURE);
    evidence.categories.push(FailureCategory.BANK_FAILURE);
  }

  if (
    codeLower.includes('auth') ||
    codeLower.includes('authentication') ||
    codeLower.includes('verify')
  ) {
    categories.push(FailureCategory.AUTH_FAILURE);
    evidence.categories.push(FailureCategory.AUTH_FAILURE);
  }

  if (
    codeLower.includes('expired') ||
    codeLower.includes('expiry') ||
    codeLower.includes('valid thru')
  ) {
    categories.push(FailureCategory.EXPIRED_INSTRUMENT);
    evidence.categories.push(FailureCategory.EXPIRED_INSTRUMENT);
  }

  if (
    codeLower.includes('timeout') ||
    codeLower.includes('network') ||
    codeLower.includes('connect') ||
    codeLower.includes('connection')
  ) {
    categories.push(FailureCategory.NETWORK_TIMEOUT);
    evidence.categories.push(FailureCategory.NETWORK_TIMEOUT);
  }

  if (
    codeLower.includes('cancel') ||
    codeLower.includes('customer') ||
    codeLower.includes('payer')
  ) {
    categories.push(FailureCategory.CUSTOMER_CANCELLATION);
    evidence.categories.push(FailureCategory.CUSTOMER_CANCELLATION);
  }

  // If no categories matched, use unknown or the provider category
  if (categories.length === 0) {
    if (providerErrorCategory) {
      // Try to map provider-specific category
      const mapped = mapProviderCategory(providerErrorCategory);
      if (mapped) {
        categories.push(mapped);
        evidence.categories.push(mapped);
      } else {
        categories.push(FailureCategory.UNKNOWN);
        evidence.categories.push(FailureCategory.UNKNOWN);
      }
    } else {
      categories.push(FailureCategory.UNKNOWN);
      evidence.categories.push(FailureCategory.UNKNOWN);
    }
  }

  // Calculate time window from evidence (simplified)
  // In production, this would analyze the timestamp of the failure
  evidence.timeWindow = { start: 0, end: 23 };

  // Build diagnosis
  const primaryCategory = categories[0] || FailureCategory.UNKNOWN;
  const confidence = categories.length > 0 ? 0.8 : 0.5;

  return {
    id: `diag_${Date.now()}`,
    transactionId: '', // will be filled in
    primaryCategory,
    primaryCategoryConfidence: confidence,
    categories,
    evidence,
    patterns: [], // would be populated with actual pattern analysis
    overallRecoverability: calculateOverallRecoverability(categories),
    calculatedAt: new Date(),
  };
}

// Map provider error category to our internal categories
function mapProviderCategory(providerCategory: string): FailureCategory | null {
  const mapping: Record<string, FailureCategory> = {
    'INSUFFICIENT_FUNDS': FailureCategory.INSUFFICIENT_FUNDS,
    'INSUFFICIENT_BALANCE': FailureCategory.INSUFFICIENT_FUNDS,
    'FAILURE': FailureCategory.UNKNOWN,
    'DECLINED': FailureCategory.UNKNOWN,
    'TIMEOUT': FailureCategory.NETWORK_TIMEOUT,
    'NETWORK_ERROR': FailureCategory.NETWORK_TIMEOUT,
    'AUTHENTICATION_FAILURE': FailureCategory.AUTH_FAILURE,
    'INVALID_AUTH': FailureCategory.AUTH_FAILURE,
    'CARD_EXPIRED': FailureCategory.EXPIRED_INSTRUMENT,
    'EXPIRED_CARD': FailureCategory.EXPIRED_INSTRUMENT,
    'CARD_DECLINED': FailureCategory.EXPIRED_INSTRUMENT,
    'UNKNOWN_ERROR': FailureCategory.UNKNOWN,
  };

  return mapping[providerCategory] || null;
}

// Calculate overall recoverability from categories
function calculateOverallRecoverability(categories: FailureCategory[]): number {
  if (categories.length === 0) return 0.5;

  const transientCount = categories.filter(c =>
    TRANSIENT_CATEGORIES.includes(c)
  ).length;
  const permanentCount = categories.filter(c =>
    PERMANENT_CATEGORIES.includes(c)
  ).length;

  // Base recoverability: transient categories are more recoverable
  const baseRate = transientCount / categories.length;
  const permanentPenalty = permanentCount / categories.length * 0.3;

  return Math.max(0.01, Math.min(0.99, baseRate - permanentPenalty + 0.5));
}