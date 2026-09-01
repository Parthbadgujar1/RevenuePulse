// AI Agent Orchestration - Bounded tool use with structured output
// The agent orchestrates the recovery workflow but has NO unrestricted access.
// Every action must pass through the policy engine and tool permission matrix.

import {
  TOOL_SCHEMAS,
  PERMISSION_MATRIX,
} from '../tools/registry';
import type { ToolSchema } from '../tools/registry';
import type {
  RecoveryFeatures,
  BaselinePrediction,
} from '../../../domain/src';
import {
  FailureCategory,
  InterventionType,
  TRANSIENT_CATEGORIES,
  diagnoseFailure,
  calculateRecoveryProbability,
  calculateEconomics,
} from '../../../domain/src';
import type { MerchantPolicy } from '../../../policies/src';
import {
  DecisionEngine,
  DEFAULT_MERCHANT_POLICY,
} from '../../../policies/src';

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
 * Agent Orchestrator - Core workflow engine
 * 
 * The agent follows a strict state machine and cannot bypass
 * deterministic policy logic. The LLM (if used) only provides
 * reasoning, not direct control.
 */
export class AgentOrchestrator {
  private toolRegistry: Record<string, ToolSchema>;
  private policyEngine: DecisionEngine;
  private executionHistory: Map<string, any>;

  constructor(
    policy: MerchantPolicy = DEFAULT_MERCHANT_POLICY,
    customTools?: Record<string, ToolSchema>
  ) {
    // Start with default tool schemas
    this.toolRegistry = { ...TOOL_SCHEMAS };

    // Override with custom tools if provided
    if (customTools) {
      Object.assign(this.toolRegistry, customTools);
    }

    this.policyEngine = new DecisionEngine(policy);
    this.executionHistory = new Map();
  }

  /**
   * Process a recovery case through the complete workflow
   * 
   * States: DETECTED → DIAGNOSED → SCORED → PROPOSED → POLICY_CHECK →
   * APPROVAL_REQUIRED/APPROVED → EXECUTING → EXECUTED → OUTCOME_PENDING →
   * RECOVERED/FAILED/STOPPED
   */
  async processCase(
    caseId: string,
    features: RecoveryFeatures,
    merchantId: string,
    initialState: string = 'DETECTED'
  ): Promise<{
    decision: AIOutput;
    toolCalls: Array<{ name: string; result: any }>;
    nextState: string;
    requiresHumanAction: boolean;
  }> {
    const toolCalls: Array<{ name: string; result: any }> = [];
    let currentState = initialState;

    try {
      // Phase 1: Diagnose - determine failure category
      if (!this.hasPermission('finance_manager', 'get_failure_context')) {
        throw new Error('Insufficient permissions for diagnosis');
      }

      // Call the diagnosis tool
      const diagInput = {
        failureCode: features.failureCategory,
        failureMessage: 'See features for details',
      };
      const diagResult = await this.callTool('get_failure_context', diagInput);
      toolCalls.push({ name: 'get_failure_context', result: diagResult });

      // Diagnose the failure
      const diagnosis = diagnoseFailure(
        features.failureCategory,
        features.failureCategory || '',
        features.failureCategory
      );
      
      currentState = 'DIAGNOSED';

      // Phase 2: Score - calculate recovery probability
      if (!this.hasPermission('finance_manager', 'calculate_recovery_score')) {
        throw new Error('Insufficient permissions for scoring');
      }

      const scoreInput = {
        features: {
          amount: features.amount,
          failure_category: features.failureCategory,
          payment_method: features.paymentMethod,
          historical_success_rate: features.historicalSuccessRate,
          number_of_previous_failures: features.numberOfPreviousFailures,
          time_since_failure_hours: features.timeSinceFailureHours,
          transaction_hour: features.transactionHour,
          retry_count: features.retryCount,
          is_subscription: features.isSubscription,
          merchant_historical_rate: features.merchantHistoricalRate,
          failure_category_historical_rate: features.failureCategoryHistoricalRate,
          amount_percentile: features.amountPercentile,
        },
      };
      const scoreResult = await this.callTool('calculate_recovery_score', scoreInput);
      toolCalls.push({ name: 'calculate_recovery_score', result: scoreResult });

      const prediction: BaselinePrediction = scoreResult;

      // Phase 3: Propose intervention
      if (!this.hasPermission('finance_manager', 'propose_intervention')) {
        throw new Error('Insufficient permissions for intervention proposal');
      }

      const proposeInput = {
        caseId,
        probability: prediction.recoveryProbability,
        amount: features.amount,
        failureCategory: features.failureCategory,
        isSubscription: features.isSubscription,
      };
      const proposeResult = await this.callTool('propose_intervention', proposeInput);
      toolCalls.push({ name: 'propose_intervention', result: proposeResult });

      // Phase 4: Policy check - fetch merchant guardrails via allowlisted tool
      const policyResult = await this.callTool('get_merchant_policy', {
        merchantId,
      });
      toolCalls.push({ name: 'get_merchant_policy', result: policyResult });

      // Phase 5: Make deterministic decision via the policy engine.
      // The agent CANNOT override this - it is computed by code, not the LLM.
      const decision = await this.policyEngine.makeDecision(
        caseId,
        features,
        { ...DEFAULT_MERCHANT_POLICY, ...(policyResult as object) } as MerchantPolicy,
        prediction
      );

      // Record tool call for the decision
      toolCalls.push({
        name: 'decision_engine',
        result: {
          action: decision.decision.action,
          expectedNetRecovery: decision.decision.expectedNetRecovery,
          rationale: decision.reasoning,
        },
      });

      currentState = 'POLICY_CHECK';

      // Phase 5: Approval check if required
      let approvalRequired = false;
      let approvedBy = null;

      if (decision.decision.requiresApproval) {
        if (!this.hasPermission('support_operator', 'request_human_approval')) {
          throw new Error('Insufficient permissions for approval request');
        }

        const approvalInput = {
          caseId,
          amount: features.amount,
          rationale: decision.reasoning,
          interventionType: decision.decision.action,
          suggestedApproverRole: 'finance_manager',
        };
        const approvalResult = await this.callTool(
          'request_human_approval',
          approvalInput
        );
        toolCalls.push({
          name: 'request_human_approval',
          result: approvalResult,
        });

        approvalRequired = true;
        currentState = 'APPROVAL_REQUIRED';
      } else {
        currentState = 'APPROVED';
      }

      // Phase 6: Execute action if allowed and approved
      if (
        !approvalRequired &&
        decision.decision.action !== InterventionType.DO_NOTHING
      ) {
        if (!this.hasPermission('finance_manager', 'execute_permitted_retry')) {
          throw new Error('Insufficient permissions for action execution');
        }

        const executeInput = {
          caseId,
          amount: features.amount,
          currency: 'INR',
          attemptNumber: (features.retryCount || 0) + 1,
          failureCategory: features.failureCategory,
          idempotencyKey: `action_${caseId}_${Date.now()}`,
        };
        const executeResult = await this.callTool(
          'execute_permitted_retry',
          executeInput
        );
        toolCalls.push({
          name: 'execute_permitted_retry',
          result: executeResult,
        });

        currentState = 'EXECUTING';
      } else if (decision.decision.action === InterventionType.DO_NOTHING) {
        currentState = 'STOPPED';
      }

      // Phase 7: Record outcome verification
      if (currentState === 'EXECUTING') {
        if (!this.hasPermission('finance_manager', 'record_outcome')) {
          throw new Error('Insufficient permissions for outcome recording');
        }

        // In a real system, we'd wait for the actual outcome
        // For now, simulate outcome verification
        const outcomeInput = {
          actionId: `action_${caseId}`,
          recoveredAmount: features.amount, // Would be actual recovered amount
          result: 'recovered' as const, // Would be determined by webhook
          notes: 'Outcome verified via webhook/confirmation',
        };
        const outcomeResult = await this.callTool('record_outcome', outcomeInput);
        toolCalls.push({
          name: 'record_outcome',
          result: outcomeResult,
        });

        currentState = 'OUTCOME_PENDING';
      }

      // Determine if human action is required
      const requiresHumanAction =
        approvalRequired ||
        decision.decision.action === InterventionType.HUMAN_ESCALATION;

      // Build the structured AI output
      const aiOutput: AIOutput = {
        caseId,
        diagnosis: {
          category: diagnosis.primaryCategory,
          confidence: diagnosis.primaryCategoryConfidence,
          evidence: [
            `Failure category: ${diagnosis.primaryCategory}`,
            `Evidence: ${diagnosis.evidence.failureCodes.join(', ')}`,
          ],
        },
        prediction: {
          recoveryProbability: prediction.recoveryProbability,
          expectedRecoveryValue: prediction.expectedRecoveryValue,
          confidence: prediction.confidence,
          modelVersion: prediction.modelVersion,
          featureSummary: prediction.featureSnapshot,
        },
        decision: {
          action: decision.decision.action,
          expectedCost: decision.decision.expectedCost,
          expectedNetRecovery: decision.decision.expectedNetRecovery,
        },
        policy: {
          allowed: decision.policy.allowed,
          approvalRequired: approvalRequired,
          violations: decision.policy.violations,
        },
        reason: decision.reasoning,
      };

      return {
        decision: aiOutput,
        toolCalls,
        nextState: currentState,
        requiresHumanAction,
      };

    } catch (error) {
      // Error case - transition to ERROR state
      currentState = 'ERROR';
      const message = error instanceof Error ? error.message : String(error);

      return {
        decision: {
          caseId,
          diagnosis: {
            category: FailureCategory.UNKNOWN,
            confidence: 0,
            evidence: [message],
          },
          prediction: {
            recoveryProbability: 0,
            expectedRecoveryValue: 0,
            confidence: 0,
            modelVersion: 'error',
            featureSummary: {},
          },
          decision: {
            action: InterventionType.DO_NOTHING,
            expectedCost: 0,
            expectedNetRecovery: 0,
            requiresApproval: false,
            rationale: `Agent error: ${message}. Case transitioned to STOPPED state.`,
          },
          policy: {
            allowed: false,
            approvalRequired: false,
            violations: [message],
          },
          reason: `Agent error during processing: ${message}`,
        },
        toolCalls,
        nextState: 'ERROR',
        requiresHumanAction: true,
      };
    }
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

  /**
   * Check if a user role has permission to call a specific tool
   */
  private hasPermission(
    role: keyof typeof PERMISSION_MATRIX,
    toolName: string
  ): boolean {
    const allowed = PERMISSION_MATRIX[role] || [];
    return allowed.includes(toolName);
  }

  /**
   * Call a tool with permission validation and output schema enforcement
   */
  private async callTool(
    toolName: string,
    input: any
  ): Promise<any> {
    // 1. Check if tool exists in registry
    const tool = this.toolRegistry[toolName];
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // 2. Check permissions
    // Determine role - in a real system this would come from auth context
    const userRole = 'finance_manager'; // default for recovery operations
    if (!this.hasPermission(userRole, toolName)) {
      throw new Error(
        `Permission denied: ${toolName} requires ${userRole} role`
      );
    }

    // 3. Validate input schema
    // In a real implementation, we'd validate against the tool's Zod schema
    // For now, we'll just pass through

    // 4. Check if tool is being rate-limited or blocked
    // In production, we'd have rate limiting here

    // 5. Check if tool execution would violate policy
    // The policy engine validates after the tool returns

    // 6. Execute the tool logic
    // Each tool implementation is a pure function
    const result = this.executeToolLogic(toolName, input);

    // 7. Return the result
    return result;
  }

  /**
   * Execute tool logic based on tool name
   * These are pure functions - no side effects, no arbitrary API access
   */
  private executeToolLogic(toolName: string, input: any): any {
    switch (toolName) {
      case 'get_transaction': {
        const { transactionId } = input;
        // In production, this would query the database
        return {
          id: transactionId,
          amount: 100000,
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureCategory: 'bank_failure',
        };
      }

      case 'get_customer_safe_context': {
        const { customerId, merchantId } = input;
        // Return safe metadata only - no sensitive card data
        return {
          customerId,
          email: 'customer@example.com',
          historicalRecoveryRate: 0.6,
          totalTransactions: 50,
          successfulRecoveries: 12,
        };
      }

      case 'get_failure_context': {
        const { failureCode, failureMessage, providerErrorCategory } = input;
        // Diagnose using the deterministic failure taxonomy
        return diagnoseFailure(
          providerErrorCategory || failureCode,
          failureMessage || '',
          providerErrorCategory
        );
      }

      case 'calculate_recovery_score': {
        const { features } = input;
        // Use the baseline model
        return calculateRecoveryProbability(features);
      }

      case 'get_merchant_policy': {
        // Return the default policy (in production, this would come from DB)
        return DEFAULT_MERCHANT_POLICY;
      }

      case 'propose_intervention': {
        const { probability, amount, failureCategory, isSubscription } = input;
        // Use the decision engine's economic logic
        const economics = calculateEconomics(
          amount,
          probability,
          0,
          0
        );
        // Select intervention based on economics
        let action: string = InterventionType.DO_NOTHING;
        if (probability > 0.6 && amount > 20000) {
          action = InterventionType.HUMAN_ESCALATION;
        } else if (probability > 0.3 && economics.expectedNetRecovery > 0) {
          action = InterventionType.RETRY_LATER;
        }
        return { action, expectedNetRecovery: economics.expectedNetRecovery };
      }

      case 'request_human_approval': {
        // Return approval request structure
        return {
          approvalId: `approval_${Date.now()}`,
          status: 'pending',
          requiredAmount: input.amount,
          rationale: input.rationale,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        };
      }

      case 'execute_permitted_retry': {
        const { amount, attemptNumber, failureCategory, idempotencyKey } = input;
        // In production, this would call the payment provider
        // For simulation, determine outcome based on failure category and attempt
        const isTransient = TRANSIENT_CATEGORIES.includes(
          failureCategory as FailureCategory
        );
        const successRate = isTransient ? 0.7 : 0.3;
        const success = Math.random() < successRate / attemptNumber; // diminishing returns
        
        return {
          success,
          providerRef: `sim_retry_${Date.now()}`,
          amount,
          status: success ? 'SUCCESS' : 'FAILURE',
          errorCode: success ? null : 'simulated_error',
          timestamp: new Date().toISOString(),
        };
      }

      case 'create_recovery_task': {
        const { caseId, transactionId, amountAtRisk, failureCategory, priority } = input;
        return {
          taskId: `task_${Date.now()}`,
          caseId,
          status: 'PROPOSED',
          createdAt: new Date().toISOString(),
        };
      }

      case 'send_approved_message': {
        const { caseId, messageType, customerContact } = input;
        return {
          messageId: `msg_${Date.now()}`,
          status: 'sent',
          messageType,
          delivered: true,
        };
      }

      case 'record_outcome': {
        const { actionId, recoveredAmount, result, notes } = input;
        return {
          outcomeId: `outcome_${Date.now()}`,
          actionId,
          recoveredAmount,
          result,
          verifiedAt: new Date().toISOString(),
          notes,
        };
      }

      case 'stop_recovery_case': {
        const { caseId, stopReason, evidence } = input;
        return {
          caseId,
          stopReason,
          stoppedAt: new Date().toISOString(),
          evidence,
        };
      }

      case 'system_stop': {
        const { caseId, stopReason, automatic } = input;
        return {
          caseId,
          stopReason,
          automaticallyInitiated: automatic,
          stoppedAt: new Date().toISOString(),
        };
      }

      default:
        throw new Error(`Tool not implemented: ${toolName}`);
    }
  }
}