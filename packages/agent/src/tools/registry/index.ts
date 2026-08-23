// Tool Registry - Allowlisted tools with permission matrix
// The agent can ONLY call tools in this registry
// Every tool call is validated against this registry at runtime

import { z } from 'zod';

// Tool permission levels
export type ToolPermission =
  | 'admin' // Merchant Owner / Administrator
  | 'finance' // Finance Manager
  | 'support' // Support Operator
  | 'none';

// Tool schema interface
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  permission: ToolPermission;
  category: 'retrieval' | 'calculation' | 'execution' | 'approval' | 'audit';
}

// Define all allowlisted tools for the AI agent
// Each tool is a pure function that the agent can call
// The server validates the output before execution

// 1. Get transaction - retrieve transaction details
export const GET_TRANSACTION: ToolSchema = {
  name: 'get_transaction',
  description:
    'Retrieve transaction details by provider transaction ID',
  inputSchema: z.object({
    transactionId: z.string(),
  }),
  permission: 'finance',
  category: 'retrieval',
};

// 2. Get customer safe context - customer metadata without sensitive data
export const GET_CUSTOMER_SAFE_CONTEXT: ToolSchema = {
  name: 'get_customer_safe_context',
  description:
    'Get customer-safe context for recovery decision (email, safe metadata only)',
  inputSchema: z.object({
    customerId: z.string(),
    merchantId: z.string(),
  }),
  permission: 'finance',
  category: 'retrieval',
};

// 3. Get failure context - diagnose failure category
export const GET_FAILURE_CONTEXT: ToolSchema = {
  name: 'get_failure_context',
  description:
    'Get structured failure diagnosis from raw error codes',
  inputSchema: z.object({
    failureCode: z.string(),
    failureMessage: z.string(),
    providerErrorCategory: z.string().optional(),
  }),
  permission: 'finance',
  category: 'retrieval',
};

// 4. Calculate recovery score - compute recovery probability
export const CALCULATE_RECOVERY_SCORE: ToolSchema = {
  name: 'calculate_recovery_score',
  description:
    'Calculate recovery probability using baseline model',
  inputSchema: z.object({
    features: z.object({
      amount: z.number(),
      failure_category: z.string(),
      payment_method: z.string(),
      historical_success_rate: z.number().min(0).max(1),
      number_of_previous_failures: z.number().min(0),
      time_since_failure_hours: z.number().min(0),
      transaction_hour: z.number().min(0).max(23),
      retry_count: z.number().min(0),
      is_subscription: z.boolean(),
      merchant_historical_rate: z.number().min(0).max(1),
      failure_category_historical_rate: z.number().min(0).max(1),
      amount_percentile: z.number().min(0).max(1),
    }),
  }),
  permission: 'finance',
  category: 'calculation',
};

// 5. Get merchant policy - retrieve merchant guardrail configuration
export const GET_MERCHANT_POLICY: ToolSchema = {
  name: 'get_merchant_policy',
  description: 'Retrieve merchant-configured guardrail policy',
  inputSchema: z.object({
    merchantId: z.string(),
  }),
  permission: 'admin',
  category: 'retrieval',
};

// 6. Propose intervention - recommend intervention type
export const PROPOSE_INTERVENTION: ToolSchema = {
  name: 'propose_intervention',
  description:
    'Recommend intervention type based on prediction and policy',
  inputSchema: z.object({
    caseId: z.string(),
    probability: z.number().min(0).max(1),
    amount: z.number(),
    failureCategory: z.string(),
    isSubscription: z.boolean(),
  }),
  permission: 'finance',
  category: 'calculation',
};

// 7. Request human approval - escalate to human for high-value cases
export const REQUEST_HUMAN_APPROVAL: ToolSchema = {
  name: 'request_human_approval',
  description:
    'Create human approval request for high-value or high-risk actions',
  inputSchema: z.object({
    caseId: z.string(),
    amount: z.number(),
    rationale: z.string(),
    interventionType: z.string(),
    suggestedApproverRole: z.enum(['merchant_owner', 'finance_manager']),
  }),
  permission: 'support',
  category: 'approval',
};

// 8. Execute permitted retry - retry payment with idempotency
export const EXECUTE_PERMITTED_RETRY: ToolSchema = {
  name: 'execute_permitted_retry',
  description:
    'Execute a permitted retry via the payment provider (simulation or Razorpay)',
  inputSchema: z.object({
    caseId: z.string(),
    amount: z.number(),
    currency: z.string(),
    attemptNumber: z.number().min(1),
    failureCategory: z.string(),
    idempotencyKey: z.string(),
  }),
  permission: 'finance',
  category: 'execution',
};

// 9. Create recovery task - create recovery task in the system
export const CREATE_RECOVERY_TASK: ToolSchema = {
  name: 'create_recovery_task',
  description:
    'Create a recovery task case in the system',
  inputSchema: z.object({
    caseId: z.string(),
    transactionId: z.string(),
    amountAtRisk: z.number(),
    failureCategory: z.string(),
    priority: z.number(),
  }),
  permission: 'finance',
  category: 'execution',
};

// 10. Send approved message - send message to customer (simulated)
export const SEND_APPROVED_MESSAGE: ToolSchema = {
  name: 'send_approved_message',
  description:
    'Send approved message to customer (simulated email/SMS)',
  inputSchema: z.object({
    caseId: z.string(),
    messageType: z.enum(['retry_initiated', 'recovery_success', 'recovery_failed']),
    customerContact: z.string(),
  }),
  permission: 'support',
  category: 'execution',
};

// 11. Record outcome - record recovery outcome verification
export const RECORD_OUTCOME: ToolSchema = {
  name: 'record_outcome',
  description:
    'Record the outcome of a recovery action (verified recovered, failed, stopped)',
  inputSchema: z.object({
    actionId: z.string(),
    recoveredAmount: z.number(),
    result: z.enum(['recovered', 'failed', 'stopped']),
    notes: z.string().optional(),
  }),
  permission: 'finance',
  category: 'audit',
};

// 12. Stop recovery case - stop a recovery case that should not proceed
export const STOP_RECOVERY_CASE: ToolSchema = {
  name: 'stop_recovery_case',
  description:
    'Stop a recovery case due to policy violation, max attempts, or customer decline',
  inputSchema: z.object({
    caseId: z.string(),
    stopReason: z.enum(['policy_violation', 'max_attempts', 'customer_decline', 'exhausted']),
    evidence: z.string().optional(),
  }),
  permission: 'support',
  category: 'audit',
};

// 13. System stop - for system-initiated stops
export const SYSTEM_STOP: ToolSchema = {
  name: 'system_stop',
  description:
    'System-initiated stop for cases exceeding limits or staleness',
  inputSchema: z.object({
    caseId: z.string(),
    stopReason: z.string(),
    automatic: z.boolean().default(true),
  }),
  permission: 'admin',
  category: 'audit',
};

// Export all tool schemas
export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  [GET_TRANSACTION.name]: GET_TRANSACTION,
  [GET_CUSTOMER_SAFE_CONTEXT.name]: GET_CUSTOMER_SAFE_CONTEXT,
  [GET_FAILURE_CONTEXT.name]: GET_FAILURE_CONTEXT,
  [CALCULATE_RECOVERY_SCORE.name]: CALCULATE_RECOVERY_SCORE,
  [GET_MERCHANT_POLICY.name]: GET_MERCHANT_POLICY,
  [PROPOSE_INTERVENTION.name]: PROPOSE_INTERVENTION,
  [REQUEST_HUMAN_APPROVAL.name]: REQUEST_HUMAN_APPROVAL,
  [EXECUTE_PERMITTED_RETRY.name]: EXECUTE_PERMITTED_RETRY,
  [CREATE_RECOVERY_TASK.name]: CREATE_RECOVERY_TASK,
  [SEND_APPROVED_MESSAGE.name]: SEND_APPROVED_MESSAGE,
  [RECORD_OUTCOME.name]: RECORD_OUTCOME,
  [STOP_RECOVERY_CASE.name]: STOP_RECOVERY_CASE,
  [SYSTEM_STOP.name]: SYSTEM_STOP,
};

// Canonical tool-name lists per role, referenced when composing roles so the
// matrix never self-references during its own initialization.
const MERCHANT_OWNER_TOOLS: string[] = [
  GET_TRANSACTION.name,
  GET_CUSTOMER_SAFE_CONTEXT.name,
  GET_FAILURE_CONTEXT.name,
  CALCULATE_RECOVERY_SCORE.name,
  GET_MERCHANT_POLICY.name,
  PROPOSE_INTERVENTION.name,
  REQUEST_HUMAN_APPROVAL.name,
  EXECUTE_PERMITTED_RETRY.name,
  CREATE_RECOVERY_TASK.name,
  SEND_APPROVED_MESSAGE.name,
  RECORD_OUTCOME.name,
  STOP_RECOVERY_CASE.name,
  SYSTEM_STOP.name,
];

// Export permission matrix by role
export const PERMISSION_MATRIX: Record<string, string[]> = {
  // Merchant Owner: full access
  merchant_owner: MERCHANT_OWNER_TOOLS,

  // Finance Manager: analytics + recovery cases + financial actions
  finance_manager: [
    GET_TRANSACTION.name,
    GET_CUSTOMER_SAFE_CONTEXT.name,
    GET_FAILURE_CONTEXT.name,
    CALCULATE_RECOVERY_SCORE.name,
    PROPOSE_INTERVENTION.name,
    EXECUTE_PERMITTED_RETRY.name,
    CREATE_RECOVERY_TASK.name,
    RECORD_OUTCOME.name,
  ],

  // Support Operator: view cases + handle approvals + messaging
  support_operator: [
    GET_TRANSACTION.name,
    GET_CUSTOMER_SAFE_CONTEXT.name,
    GET_FAILURE_CONTEXT.name,
    CALCULATE_RECOVERY_SCORE.name,
    PROPOSE_INTERVENTION.name,
    REQUEST_HUMAN_APPROVAL.name,
    SEND_APPROVED_MESSAGE.name,
  ],

  // Administrator: system configuration + everything an owner has
  administrator: [
    ...MERCHANT_OWNER_TOOLS,
  ],
};
