// Decision Engine - Economic decision-making with policy guardrails
// Implements the closed loop: Detect → Diagnose → Predict → Decide →
// Validate → Act → Observe → Measure → Learn
// 
// Key principle: Never execute a recovery action merely because recovery
// probability is non-zero. Prefer actions with positive expected economic
// value and policy eligibility.

import {
  RecoveryFeatures,
  BaselinePrediction,
  EconomicCalculation,
  PolicyCheckResult,
  InterventionType,
  InterventionDefinition,
  INTERVENTIONS,
  FailureCategory,
  FailureStatistics,
  TRANSIENT_CATEGORIES,
  PERMANENT_CATEGORIES,
  CATEGORIES_WITH_RETRY,
  CATEGORIES_NO_RETRY,
  calculateRecoveryProbability,
  calculateEconomics,
  isInterventionAllowed,
  getInterventionDefinition,
} from '../../domain/src';

// Merchant policy configuration type
export interface MerchantPolicy {
  maximumIncentivePercentage: number;
  maximumIncentiveAmount: number; // in paise
  maximumRecoveryValue: number; // in paise - max value eligible for autonomous action
  maximumRetryCount: number;
  maximumContactCount: number;
  minimumRecoveryProbability: number; // 0-1
  minimumExpectedNetRecovery: number; // in paise
  humanApprovalThreshold: number; // in paise - above this, approval required
  allowedInterventionTypes: InterventionType[];
  cooldownPeriod: number; // hours
  maximumCaseLifetime: number; // days
  stopOnCustomerDecline: boolean;
  stopOnRepeatedFailure: boolean;
  stopOnPolicyViolation: boolean;
  autoActionEnable: boolean;
}

// Default merchant policy (configurable by merchant)
export const DEFAULT_MERCHANT_POLICY: MerchantPolicy = {
  maximumIncentivePercentage: 10,
  maximumIncentiveAmount: 2500000, // ₹25,000 in paise
  maximumRecoveryValue: 2500000, // ₹25,000
  maximumRetryCount: 3,
  maximumContactCount: 2,
  minimumRecoveryProbability: 0.2, // 20%
  minimumExpectedNetRecovery: 100, // ₹1 in paise
  humanApprovalThreshold: 1000000, // ₹10,000 in paise
  allowedInterventionTypes: [
    InterventionType.RETRY_LATER,
    InterventionType.TIMED_REMINDER,
    InterventionType.PAYMENT_METHOD_RECOVERY,
    InterventionType.HUMAN_ESCALATION,
    InterventionType.DO_NOTHING,
  ],
  cooldownPeriod: 24,
  maximumCaseLifetime: 30,
  stopOnCustomerDecline: true,
  stopOnRepeatedFailure: true,
  stopOnPolicyViolation: true,
  autoActionEnable: true,
};

// Decision result type
export interface DecisionResult {
  caseId: string;
  diagnosis: {
    category: FailureCategory;
    confidence: number;
    evidence: string[];
  };
  prediction: {
    probability: number;
    expectedRecoveryValue: number;
    confidence: number;
    modelVersion: string;
  };
  decision: {
    action: InterventionType;
    expectedCost: number; // in paise
    expectedNetRecovery: number; // in paise
    requiresApproval: boolean;
    rationale: string;
  };
  policy: {
    allowed: boolean;
    violations: string[];
    stoppingRuleTriggered?: boolean;
    blockedAlternatives?: { action: string; reason: string }[];
    policySnapshot: MerchantPolicy;
  };
  reasoning: string;
  timestamp: Date;
}

// Decision engine class
export class DecisionEngine {
  private policy: MerchantPolicy;

  constructor(policy: MerchantPolicy = DEFAULT_MERCHANT_POLICY) {
    this.policy = policy;
  }

  /**
   * Make a complete recovery decision for a case.
   *
   * Workflow:
   * 1. Use the provided ML prediction (trained model.joblib via the FastAPI
   *    service) OR fall back to the transparent heuristic baseline when no
   *    prediction is injected (standalone/testing use only)
   * 2. Calculate economic value (expected net recovery)
   * 3. Check policy compliance
   * 4. Select optimal intervention
   * 5. Determine approval requirements
   *
   * Returns DO_NOTHING if no action has positive expected value
   * or if policy blocks the action.
   */
  async makeDecision(
    caseId: string,
    features: RecoveryFeatures,
    existingPolicy?: MerchantPolicy,
    prediction?: BaselinePrediction
  ): Promise<DecisionResult> {
    const policy = existingPolicy || this.policy;

    // Step 1: Recovery probability — production callers MUST inject the
    // trained-model prediction; calculateRecoveryProbability remains only as
    // the documented transparent fallback for standalone/testing use.
    const resolved = prediction ?? calculateRecoveryProbability(features);

    // Step 2: Calculate economics
    const economics = calculateEconomics(
      features.amount,
      resolved.recoveryProbability,
      0, // base action cost - will be adjusted by intervention
      0  // no incentive by default
    );

    // Step 3: Check policy compliance
    const policyCheck = isInterventionAllowed(
      InterventionType.DO_NOTHING, // we'll check all interventions
      policy,
      features
    );

    // Step 4: Evaluate all interventions.
    // Baseline = DO_NOTHING with ZERO incremental net recovery:
    // doing nothing costs nothing and recovers nothing.
    let bestAction: InterventionType = InterventionType.DO_NOTHING;
    let bestNetRecovery = 0;
    let bestRationale = "No intervention beats doing nothing (₹0 incremental value).";
    let requiresApproval = false;
    const violations: string[] = [];
    const blockedAlternatives: { action: string; reason: string }[] = [];

    // Evaluate each allowed intervention
    for (const interventionType of policy.allowedInterventionTypes) {
      if (interventionType === InterventionType.DO_NOTHING) continue;

      const definition = INTERVENTIONS[interventionType];
      if (!definition) continue;

      // Check prerequisites
      const prerequisitesMet = definition.prerequisites({
        probability: resolved.recoveryProbability,
        amount: features.amount,
        policy,
        features,
      });

      if (!prerequisitesMet) {
        blockedAlternatives.push({
          action: interventionType,
          reason: 'Prerequisites not met',
        });
        continue;
      }

      // Check if intervention is allowed under policy
      const allowedResult = isInterventionAllowed(
        interventionType,
        policy,
        features
      );

      if (!allowedResult.allowed) {
        violations.push(`${interventionType}: ${allowedResult.reason}`);
        blockedAlternatives.push({ action: interventionType, reason: allowedResult.reason });
        continue;
      }

      // Intervention-specific effectiveness lift on the predicted probability.
      // Mirrors the demo-mode ground-truth simulator so decision economics
      // reflect how each intervention actually shifts recovery odds by category.
      const EFFECTIVENESS_LIFT: Record<string, number> = {
        [InterventionType.RETRY_LATER]:
          [FailureCategory.NETWORK_TIMEOUT, FailureCategory.BANK_FAILURE].includes(features.failureCategory) ? 0.05 : 0,
        [InterventionType.TIMED_REMINDER]:
          features.failureCategory === FailureCategory.INSUFFICIENT_FUNDS ? 0.08 : 0,
        [InterventionType.PAYMENT_METHOD_RECOVERY]:
          [FailureCategory.EXPIRED_INSTRUMENT, FailureCategory.PAYMENT_METHOD_DEGRADATION].includes(features.failureCategory) ? 0.15 : -0.05,
        [InterventionType.HUMAN_ESCALATION]: 0.1,
      };
      const effectiveProbability = Math.min(
        0.95,
        Math.max(0.01, resolved.recoveryProbability + (EFFECTIVENESS_LIFT[interventionType] ?? 0))
      );

      // Calculate economics for this intervention
      const interventionEconomics = calculateEconomics(
        features.amount,
        effectiveProbability,
        definition.expectedCost,
        0 // no incentive for now
      );

      // Select argmax(expected incremental net recovery), must beat ₹0
      if (interventionEconomics.expectedNetRecovery > bestNetRecovery &&
          interventionEconomics.expectedNetRecovery >= policy.minimumExpectedNetRecovery) {
        bestNetRecovery = interventionEconomics.expectedNetRecovery;
        bestAction = interventionType;

        // Build rationale
        const amountStr = (features.amount / 100).toLocaleString();
        const probStr = (resolved.recoveryProbability * 100).toFixed(1);
        const netStr = (interventionEconomics.expectedNetRecovery / 100).toLocaleString();
        bestRationale = `High recoverability and positive expected net recovery (₹${netStr}) within merchant limits. Amount: ₹${amountStr}, Probability: ${probStr}%.`;

        // Approval based on explicit thresholds, not unrelated economics
        requiresApproval =
          features.amount >= policy.humanApprovalThreshold ||
          interventionType === InterventionType.HUMAN_ESCALATION;
      }
    }

    // Stopping rules: DO_NOTHING forced by hard stops counts as a stop event
    const stoppingRuleTriggered =
      violations.length > 0 &&
      bestAction === InterventionType.DO_NOTHING &&
      policy.stopOnPolicyViolation;

    if (bestAction === InterventionType.DO_NOTHING && violations.length === 0) {
      bestRationale = economicDoNothingRationale(
        features.amount,
        resolved.recoveryProbability,
        economics
      );
    }

    // Build the decision result
    const decision: DecisionResult = {
      caseId,
      diagnosis: {
        category: features.failureCategory,
        confidence: resolved.confidence,
        evidence: [
          `Failure category: ${features.failureCategory}`,
          `Amount at risk: ₹${(features.amount / 100).toLocaleString()}`,
          `Recovery probability: ${(resolved.recoveryProbability * 100).toFixed(1)}%`,
        ],
      },
      prediction: {
        probability: resolved.recoveryProbability,
        expectedRecoveryValue: resolved.expectedRecoveryValue,
        confidence: resolved.confidence,
        modelVersion: resolved.modelVersion,
      },
      decision: {
        action: bestAction,
        expectedCost: INTERVENTIONS[bestAction]?.expectedCost || 0,
        expectedNetRecovery: bestNetRecovery,
        requiresApproval,
        rationale: bestRationale,
      },
      policy: {
        // The chosen action is always policy-compliant; DO_NOTHING is the
        // compliant fallback when every intervention was blocked.
        allowed: bestAction !== InterventionType.DO_NOTHING || violations.length === 0,
        violations,
        stoppingRuleTriggered,
        blockedAlternatives,
        policySnapshot: policy,
      },
      reasoning: buildDecisionReasoning(
        bestAction,
        resolved,
        economics,
        policy,
        features.amount
      ),
      timestamp: new Date(),
    };

    return decision;
  }
}

/**
 * Generate the "do nothing" rationale explanation
 */
function economicDoNothingRationale(
  amount: number,
  probability: number,
  economics: EconomicCalculation
): string {
  const amountStr = (amount / 100).toLocaleString();
  const probStr = (probability * 100).toFixed(1);
  const netStr = (economics.expectedNetRecovery / 100).toLocaleString();

  return `Low economic value or negative expected recovery. Amount: ₹${amountStr}, ` +
    `Probability: ${probStr}%, Expected Net: ₹${netStr}. ` +
    `Decision: DO NOTHING - awaiting more favorable conditions.`;
}

/**
 * Build comprehensive decision reasoning string
 */
function buildDecisionReasoning(
  action: InterventionType,
  prediction: BaselinePrediction,
  economics: EconomicCalculation,
  policy: MerchantPolicy,
  amount: number
): string {
  const amountStr = (amount / 100).toLocaleString();
  const probStr = (prediction.recoveryProbability * 100).toFixed(1);
  const expectedStr = (economics.expectedRecoveryValue / 100).toLocaleString();
  const netStr = (economics.expectedNetRecovery / 100).toLocaleString();
  const costStr = (economics.estimatedActionCost / 100).toLocaleString();

  // Check key decision factors
  const parts: string[] = [];

  // Economic foundation
  parts.push(`Expected recovery: ₹${expectedStr}`);
  parts.push(`Expected net recovery: ₹${netStr}`);
  parts.push(`Action cost: ₹${costStr}`);

  // Probability and risk
  parts.push(`Recovery probability: ${probStr}%`);
  parts.push(`Customer friction risk: ${economics.customerFrictionRisk.toFixed(1)}`);

  // Policy check
  const policyEligible = economics.policyEligible;
  parts.push(`Policy eligible: ${policyEligible}`);

  // Intervention selection
  parts.push(`Selected action: ${action}`);

  // Do-nothing case
  if (action === InterventionType.DO_NOTHING) {
    parts.push(`Reason: ${economicDoNothingRationale(
      amount,
      prediction.recoveryProbability,
      economics
    )}`);
  } else {
    const definition = INTERVENTIONS[action];
    if (definition) {
      parts.push(`Expected cost: ₹${costStr}`);
      parts.push(`Merchant policy: ${definition.description}`);
    }
  }

  // Policy status
  parts.push(`Policy: ${policyEligible ? 'allowed' : 'blocked'}`);

  return parts.join('. ');
}