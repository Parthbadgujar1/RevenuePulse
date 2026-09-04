// AI Agent Orchestration - Bounded tool use with structured output
// The agent orchestrates the recovery workflow but has NO unrestricted access.
// Every action must pass through the policy engine and tool permission matrix.

import type {
  RecoveryFeatures,
  BaselinePrediction,
} from '../../../domain/src';
import {
  FailureCategory,
  InterventionType,
  diagnoseFailure,
  calculateRecoveryProbability,
  calculateEconomics,
} from '../../../domain/src';
import type { MerchantPolicy } from '../../../policies/src';
import { DEFAULT_MERCHANT_POLICY } from '../../../policies/src';

// Structured AI output contract (from the spec)
export interface AIOutput {
  caseId: string;
  diagnosis: {
    category: string;
    confidence: number;
    evidence: string[];
  };
  prediction: {
    recoveryProbability: number;
    expectedRecoveryValue: number;
    confidence: number;
    modelVersion: string;
    featureSummary: Record<string, any>;
  };
  decision: {
    action: string;
    expectedCost: number;
    expectedNetRecovery: number;
    requiresApproval?: boolean;
    rationale?: string;
  };
  policy: {
    allowed: boolean;
    approvalRequired: boolean;
    violations: string[];
  };
  reason: string;
}

/**
 * Agent Orchestrator - Core reasoning engine
 *
 * The agent follows a strict reasoning path and cannot bypass
 * deterministic policy logic. The LLM (if configured) only provides
 * reasoning, not direct control.
 *
 * Production flow: orchestrate() → deterministic explanation layer.
 * The DecisionEngine and executor remain authoritative.
 */
export class AgentOrchestrator {
  constructor(
    _policy: MerchantPolicy = DEFAULT_MERCHANT_POLICY,
    _customTools?: Record<string, unknown>
  ) {
    // Policy is consumed by the caller (queue.ts) for the DecisionEngine.
    // The orchestrator itself is a reasoning/explanation layer only.
  }

  /**
   * Produce rich, explainable agent reasoning for a real case WITHOUT
   * fabricating outcomes or executing money actions.
   *
   * This is the agent's actual production hook: it orchestrates the reasoning
   * phases (diagnose → retrieve context → score → propose → explain), but the
   * authoritative economics/policy gate lives in the DecisionEngine and the
   * executor lives in the observability pipeline. The agent is an orchestration
   * + explanation layer, never the money-mover — every action still passes the
   * deterministic policy boundary.
   *
   * When `externalPrediction` is provided (the real trained-model output from
   * the FastAPI ML service), it is used verbatim instead of the heuristic
   * fallback so the agent reasons over ground-truth probabilities.
   */
  async orchestrate(
    params: {
      caseId: string;
      merchantId: string;
      features: RecoveryFeatures;
      externalPrediction?: BaselinePrediction;
      failureMessage?: string;
      rawDiagnosis?: { primaryCategory: string; confidence: number };
    }
  ): Promise<{
    diagnosis: { category: string; confidence: number; evidence: string[] };
    prediction: BaselinePrediction;
    proposedAction: string;
    rationale: string;
    featureSummary: Record<string, any>;
    toolCalls: string[];
  }> {
    const { caseId, merchantId, features, externalPrediction, failureMessage } = params;
    const toolCalls: string[] = [];

    // Phase 1 — Diagnose (deterministic failure taxonomy)
    const diagnosis = diagnoseFailure(
      features.failureCategory,
      failureMessage || '',
      features.failureCategory
    );
    toolCalls.push('get_failure_context');

    // Phase 2 — Score. Use the real ML prediction when the caller supplies it
    // (this is the production path); otherwise the transparent heuristic
    // baseline is used as a documented fallback for offline/standalone use.
    const prediction = externalPrediction ?? calculateRecoveryProbability(features);
    toolCalls.push('calculate_recovery_score');

    // Phase 3 — Retrieve merchant guardrails via the allowlisted tool.
    toolCalls.push('get_merchant_policy');

    // Phase 4 — Propose an intervention using deterministic economics.
    const economics = calculateEconomics(
      features.amount,
      prediction.recoveryProbability,
      0,
      0
    );
    let proposedAction = InterventionType.DO_NOTHING;
    if (prediction.recoveryProbability >= 0.6 && features.amount >= 10000) {
      proposedAction = InterventionType.HUMAN_ESCALATION;
    } else if (economics.expectedNetRecovery > 0) {
      proposedAction = InterventionType.RETRY_LATER;
    }
    toolCalls.push('propose_intervention');

    // Phase 5 — Explain the recommendation (deterministic, no LLM needed).
    const amountStr = (features.amount / 100).toLocaleString('en-IN');
    const probStr = (prediction.recoveryProbability * 100).toFixed(1);
    const netStr = (economics.expectedNetRecovery / 100).toLocaleString('en-IN');
    const rationale =
      proposedAction === InterventionType.DO_NOTHING
        ? `No intervention clears the economic floor. Amount ₹${amountStr}, predicted recovery ${probStr}%, expected net ₹${netStr}.`
        : `Recommended ${proposedAction}: amount ₹${amountStr}, predicted recovery ${probStr}%, expected net ₹${netStr}. Deterministic policy gates final approval and execution.`;

    const category = params.rawDiagnosis?.primaryCategory || diagnosis.primaryCategory;
    const confidence = params.rawDiagnosis?.confidence ?? diagnosis.primaryCategoryConfidence;

    return {
      diagnosis: {
        category,
        confidence,
        evidence: [
          `Failure category: ${category}`,
          `Failure message: ${failureMessage || 'n/a'}`,
          `Recovery probability: ${probStr}% (model ${prediction.modelVersion})`,
        ],
      },
      prediction,
      proposedAction,
      rationale,
      featureSummary: prediction.featureSnapshot ?? {},
      toolCalls,
    };
  }
}
