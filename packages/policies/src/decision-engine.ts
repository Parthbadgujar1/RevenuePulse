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
  humanApprovalThreshold: 10000, // ₹10,000 in paise
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
   * 1. Calculate recovery probability using baseline model
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
    existingPolicy?: MerchantPolicy
  ): Promise<DecisionResult> {
    const policy = existingPolicy || this.policy;

    // Step 1: Calculate recovery probability
    const prediction = calculateRecoveryProbability(features);

    // Step 2: Calculate economics
    const economics = calculateEconomics(
      features.amount,
      prediction.recoveryProbability,
      0, // base action cost - will be adjusted by intervention
      0  // no incentive by default
    );

    // Step 3: Check policy compliance
    const policyCheck = isInterventionAllowed(
      InterventionType.DO_NOTHING, // we'll check all interventions
      policy,
      features
    );

    // Step 4: Evaluate all interventions and select the best
    let bestAction: InterventionType = InterventionType.DO_NOTHING;
    let bestNetRecovery = economics.expectedNetRecovery;
    let bestRationale = "";
    let requiresApproval = false;

    // Evaluate each allowed intervention
    for (const interventionType of policy.allowedInterventionTypes) {
      const definition = INTERVENTIONS[interventionType];
      if (!definition) continue;

      // Check prerequisites
      const prerequisitesMet = definition.prerequisites({
        probability: prediction.recoveryProbability,
        amount: features.amount,
        policy,
        features,
      });

      if (!prerequisitesMet) continue;

      // Check if intervention is allowed under policy
      const allowedResult = isInterventionAllowed(
        interventionType,
        policy,
        features
      );

      if (!allowedResult.allowed) continue;

      // Calculate economics for this intervention
      // Use the intervention's expected cost
      const interventionEconomics = calculateEconomics(
        features.amount,
        prediction.recoveryProbability,
        definition.expectedCost,
        0 // no incentive for now
      );

      // Select the intervention with the highest positive expected net recovery
      if (interventionEconomics.expectedNetRecovery > bestNetRecovery &&
          interventionEconomics.expectedNetRecovery > 0) {
        bestNetRecovery = interventionEconomics.expectedNetRecovery;
        bestAction = interventionType;
        
        // Build rationale
        const amountStr = (features.amount / 100).toLocaleString();
        const probStr = (prediction.recoveryProbability * 100).toFixed(1);
        const netStr = (interventionEconomics.expectedNetRecovery / 100).toLocaleString();
        bestRationale = `High recoverability and positive expected net recovery (₹${netStr}) within merchant limits. Amount: ₹${amountStr}, Probability: ${probStr}%.`;
        
        requiresApproval = interventionType === InterventionType.HUMAN_ESCALATION ||
                          economics.expectedNetRecovery > policy.humanApprovalThreshold;
      }
    }

    // If no intervention has positive expected net recovery, default to DO_NOTHING
    if (bestAction === InterventionType.DO_NOTHING || bestNetRecovery <= 0) {
      bestRationale = economicDoNothingRationale(
        features.amount,
        prediction.recoveryProbability,
        economics
      );
      bestAction = InterventionType.DO_NOTHING;
      requiresApproval = false;
      bestNetRecovery = economics.expectedNetRecovery;
    }

    // Build the decision result
    const decision: DecisionResult = {
      caseId,
      diagnosis: {
        category: features.failureCategory,
        confidence: prediction.confidence,
        evidence: [
          `Failure category: ${features.failureCategory}`,
          `Amount at risk: ₹${(features.amount / 100).toLocaleString()}`,
          `Recovery probability: ${(prediction.recoveryProbability * 100).toFixed(1)}%`,
        ],
      },
      prediction: {
        probability: prediction.recoveryProbability,
        expectedRecoveryValue: prediction.expectedRecoveryValue,
        confidence: prediction.confidence,
        modelVersion: prediction.modelVersion,
      },
      decision: {
        action: bestAction,
        expectedCost: INTERVENTIONS[bestAction]?.expectedCost || 0,
        expectedNetRecovery: bestNetRecovery,
        requiresApproval,
        rationale: bestRationale,
      },
      policy: {
        allowed: true,
        violations: [],
        policySnapshot: policy,
      },
      reasoning: buildDecisionReasoning(
        bestAction,
        prediction,
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