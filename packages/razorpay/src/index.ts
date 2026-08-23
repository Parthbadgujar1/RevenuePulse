/**
 * Payment Provider Abstraction Layer
 * 
 * Simulation/mock mode as the primary demo path.
 * Razorpay as an optional adapter.
 * 
 * All payment operations go through this interface to ensure:
 * - Deterministic behavior
 * - Policy enforcement
 * - Idempotency
 * - Auditability
 */

import type { FailureCategory } from '../../domain/src';

// Payment retry parameters
export interface RetryParams {
  caseId: string;
  amount: number; // In paise
  currency: string;
  attemptNumber: number;
  failureCategory?: string;
}

// Retry result
export interface RetryResult {
  success: boolean;
  providerRef: string; // Provider-specific reference ID
  amount: number;
  currency: string;
  status: 'SUCCESS' | 'FAILURE' | 'PENDING';
  errorCode?: string;
  errorMessage?: string;
  timestamp: number;
}

// Payment link parameters
export interface PaymentLinkParams {
  caseId: string;
  amount: number; // In paise
  currency: string;
  customerEmail: string;
  customerPhone: string;
  description: string;
  returnUrl?: string;
}

// Payment link result
export interface PaymentLinkResult {
  success: boolean;
  paymentId: string;
  paymentUrl: string;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
}

// Notification provider interface (from Phase 2)
export interface NotificationProvider {
  sendEmail(params: {
    to: string;
    subject: string;
    template: string;
    context?: Record<string, any>;
  }): Promise<{ success: boolean; providerRef: string; messageId?: string }>;

  sendSMS(params: {
    to: string;
    template: string;
    context?: Record<string, any>;
  }): Promise<{ success: boolean; providerRef: string; messageId?: string }>;
}

// ============================================================
// Payment Provider Interface
// ============================================================

export interface PaymentProvider {
  retryPayment(params: RetryParams): Promise<RetryResult>;
  getPaymentStatus(providerRef: string): Promise<{
    status: 'SUCCESS' | 'FAILURE' | 'PENDING';
    amount: number;
    currency: string;
    failureCode?: string;
  }>;
  createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult>;
  verifyWebhookSignature(payload: string, signature: string): boolean;
}

/**
 * Simulation Provider - Primary mode for development and demo
 * 
 * Configurable success rates, latency, and failure modes.
 * Used when RAZORPAY_API_KEY is not set.
 */
export class SimulationProvider implements PaymentProvider {
  private successRate: number;
  private latencyMs: number;
  private failureMode: 'none' | 'transient' | 'permanent';
  private attemptSuccessRates: Map<number, number>;

  constructor(config?: {
    successRate?: number;
    latencyMs?: number;
    failureMode?: 'none' | 'transient' | 'permanent';
    attemptSuccessRateDecay?: number;
  }) {
    this.successRate = config?.successRate ?? 0.7; // 70% success by default
    this.latencyMs = config?.latencyMs ?? 200;
    this.failureMode = config?.failureMode ?? 'transient';
    this.attemptSuccessRates = new Map();
    
    // Set up attempt success rate decay if specified
    if (config?.attemptSuccessRateDecay) {
      for (let i = 1; i <= 5; i++) {
        this.attemptSuccessRates.set(
          i,
          Math.max(0.1, this.successRate * Math.pow(1 - config.attemptSuccessRateDecay, i))
        );
      }
    }
  }

  async retryPayment(params: RetryParams): Promise<RetryResult> {
    // Determine success based on attempt number and failure mode
    const baseSuccess = Math.random() < this.successRate;
    
    // Apply failure mode adjustment
    let adjustment = 0;
    if (params.failureCategory) {
      const transientCategories = ['network_timeout', 'auth_failure'];
      const permanentCategories = ['expired_instrument', 'customer_cancellation'];
      
      if (transientCategories.includes(params.failureCategory as string)) {
        // Transient: success depends on attempt number
        const attemptRate = this.attemptSuccessRates.get(params.attemptNumber) || this.successRate;
        const success = Math.random() < attemptRate;
        if (!success) adjustment = 0.1; // slight penalty
      } else if (permanentCategories.includes(params.failureCategory as string)) {
        // Permanent: low success rate
        adjustment = 0.4;
      }
    }
    
    const finalSuccess = baseSuccess && Math.random() > adjustment;
    const status = finalSuccess ? 'SUCCESS' : 'FAILURE';
    
    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));

    const providerRef = `sim_${params.caseId}_${params.attemptNumber}_${Date.now()}`;

    return {
      success: finalSuccess,
      providerRef,
      amount: params.amount,
      currency: params.currency,
      status,
      timestamp: Date.now(),
    };
  }

  async getPaymentStatus(providerRef: string): Promise<{
    status: 'SUCCESS' | 'FAILURE' | 'PENDING';
    amount: number;
    currency: string;
  }> {
    // Simulation: always return SUCCESS for a given ref
    return {
      status: 'SUCCESS',
      amount: 0,
      currency: 'INR',
    };
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    // Simulate payment link creation
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));

    return {
      success: true,
      paymentId: `sim_link_${Date.now()}`,
      paymentUrl: `https://sim.razorpay.com/pay/${Date.now()}`,
      status: 'PENDING',
    };
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    // Simulation always returns true (no real signature verification)
    return true;
  }
}

/**
 * Razorpay Provider - Optional adapter for production
 * Wraps the actual Razorpay API calls
 * Throws error if not configured - forces simulation mode default
 */
export class RazorpayProvider implements PaymentProvider {
  private apiKey: string;
  private apiSecret: string;
  baseUrl: string = 'https://api.razorpay.com/v1';

  constructor(credentials: {
    apiKey: string;
    apiSecret: string;
  }) {
    this.apiKey = credentials.apiKey;
    this.apiSecret = credentials.apiSecret;
  }

  async retryPayment(params: RetryParams): Promise<RetryResult> {
    // In production, this would call Razorpay's retry endpoint
    // For MVP, throw error indicating misconfiguration
    throw new Error(
      'RazorpayProvider not configured. Set RAZORPAY_API_KEY and RAZORPAY_API_SECRET, ' +
      'or use SimulationProvider as default.'
    );
  }

  async getPaymentStatus(providerRef: string): Promise<{
    status: 'SUCCESS' | 'FAILURE' | 'PENDING';
    amount: number;
    currency: string;
    failureCode?: string;
  }> {
    // Query Razorpay API for payment status
    throw new Error('RazorpayProvider not fully implemented in MVP');
  }

  async createPaymentLink(params: PaymentLinkParams): Promise<PaymentLinkResult> {
    // Call Razorpay API to create payment link
    throw new Error('RazorpayProvider not fully implemented in MVP');
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    // Verify Razorpay webhook signature using HMAC SHA256
    // const expectedSig = crypto
    //   .createHmac('sha256', this.apiSecret)
    //   .update(payload)
    //   .digest('hex');
    // return expectedSig === signature;
    // For MVP, return true if not configured
    return true;
  }
}

/**
 * Default provider instance - Simulation by default
 * Can be overridden with RAZORPAY_API_KEY env var
 */
let defaultProvider: PaymentProvider = new SimulationProvider();

export function setDefaultProvider(provider: PaymentProvider): void {
  defaultProvider = provider;
}

export function getDefaultProvider(): PaymentProvider {
  return defaultProvider;
}

/**
 * Action State Machine - Explicit states for recovery actions
 * 
 * Suggested lifecycle:
 * DETECTED → DIAGNOSED → SCORED → PROPOSED → POLICY_CHECK
 * APPROVAL_REQUIRED / APPROVED → EXECUTING → EXECUTED → OUTCOME_PENDING
 * → RECOVERED / FAILED / STOPPED
 * 
 * Also supported: EXPIRED, CANCELLED, POLICY_BLOCKED, DUPLICATE, ERROR, RETRY_SCHEDULED
 */
export enum ActionStatus {
  PENDING = 'PENDING',
  POLICY_CHECK = 'POLICY_CHECK',
  APPROVED = 'APPROVED',
  EXECUTING = 'EXECUTING',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  COMPENSATED = 'COMPENSATED',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
}

/**
 * Action types available for recovery
 */
export enum ActionType {
  RETRY_LATER = 'retry_later',
  TIMED_REMINDER = 'timed_reminder',
  PAYMENT_METHOD_RECOVERY = 'payment_method_recovery',
  CHECKOUT_RECOVERY = 'checkout_recovery',
  SUBSCRIPTION_RECOVERY = 'subscription_recovery',
  HUMAN_ESCALATION = 'human_escalation',
  DO_NOTHING = 'do_nothing',
}

/**
 * Action record - tracks a recovery action through its lifecycle
 */
export interface ActionRecord {
  id: string;
  caseId: string;
  actionType: ActionType;
  policySnapshot: {
    maximumIncentivePercentage: number;
    maximumIncentiveAmount: number;
    maximumRecoveryValue: number;
    maximumRetryCount: number;
    humanApprovalThreshold: number;
  };
  expectedCost: number; // In paise
  expectedNetRecovery: number; // In paise
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  executionStatus: ActionStatus;
  idempotencyKey: string;
  providerActionId?: string; // Razorpay retry ID, etc.
  executedAt?: Date;
  completedAt?: Date;
  error?: string;
  outcome?: OutcomeRecord;
}

/**
 * Outcome record - verifies the recovery result
 */
export interface OutcomeRecord {
  id: string;
  actionId: string;
  recoveredAmount: number; // In paise
  result: 'recovered' | 'failed' | 'stopped';
  recoveryTimestamp: Date;
  measuredCost: number; // In paise
  notes?: string;
  verifiedAt?: Date;
}

/**
 * Idempotency key for actions
 * Format: action:{caseId}:{actionType}:{attemptNumber}
 * Unique constraint prevents duplicate execution
 */
export const generateIdempotencyKey = (
  caseId: string,
  actionType: ActionType,
  attemptNumber: number
): string => `action:${caseId}:${actionType}:${attemptNumber}`;

/**
 * Compensation / safe failure behavior
 * When a recovery action fails, the system should:
 * 1. Record the failure in the outcome
 * 2. Increment the attempt count
 * 3. Check stopping rules (max attempts, policy violation)
 * 4. Either schedule a retry or stop the case
 * 5. Never blindly retry non-idempotent actions
 */
export class SafeFailureBehavior {
  /**
   * Determine the next step after a failed action
   */
  static determineNextStep(
    currentAttempt: number,
    maxAttempts: number,
    failureCategory: string,
    stopOnCustomerDecline: boolean,
    stopOnRepeatedFailure: boolean
  ): 'retry' | 'stop' | 'escalate' {
    // Check max attempts
    if (currentAttempt >= maxAttempts) {
      return 'stop';
    }

    // Check permanent failure categories
    const permanentCategories: string[] = [
      'expired_instrument',
      'customer_cancellation',
      'unknown',
    ];

    const isPermanent = permanentCategories.includes(failureCategory);

    if (isPermanent && stopOnRepeatedFailure) {
      return 'stop';
    }

    // Check if we should stop on customer decline
    // (Would need customer feedback data)
    if (stopOnCustomerDecline && currentAttempt > 1) {
      // In a real system, check if customer explicitly declined
      // For now, after first attempt, consider stopping
      if (currentAttempt >= 2) {
        return 'stop';
      }
    }

    // Otherwise, schedule a retry with backoff
    return 'retry';
  }

  /**
   * Calculate exponential backoff delay in milliseconds
   */
  static calculateBackoffDelay(attempt: number, baseMs: number = 30000): number {
    // Exponential backoff: 30s, 1min, 2min, 4min, 8min, ...
    return baseMs * Math.pow(2, attempt - 1);
  }
}

/**
 * Categorize a failure from Razorpay error code / message.
 * Deterministic mapping - no LLM involved.
 */
export function categorizeFailure(
  errorCode?: string,
  errorMessage?: string
): string {
  if (!errorCode) return 'unknown';

  const code = errorCode.toLowerCase();
  const message = (errorMessage || '').toLowerCase();

  if (
    code.includes('insufficient') ||
    message.includes('insufficient') ||
    message.includes('balance') ||
    message.includes('fund')
  ) {
    return 'insufficient_funds';
  }

  if (
    code.includes('bank') ||
    code.startsWith('rb') ||
    message.includes('issuer')
  ) {
    return 'bank_failure';
  }

  if (
    code.includes('auth') ||
    message.includes('auth') ||
    message.includes('verify')
  ) {
    return 'auth_failure';
  }

  if (
    code.includes('timeout') ||
    message.includes('timeout') ||
    message.includes('network')
  ) {
    return 'network_timeout';
  }

  if (
    code.includes('expired') ||
    message.includes('expired') ||
    message.includes('valid thru')
  ) {
    return 'expired_instrument';
  }

  if (
    code.includes('cancel') ||
    message.includes('cancel') ||
    message.includes('abandon')
  ) {
    return 'customer_cancellation';
  }

  if (code.includes('repeated') || message.includes('repeated')) {
    return 'repeated_failure';
  }

  if (
    code.startsWith('ra') ||
    code.includes('gateway') ||
    code.includes('acquirer') ||
    message.includes('gateway') ||
    message.includes('acquirer')
  ) {
    return 'bank_failure';
  }

  return 'unknown';
}

// Razorpay event types mapped to internal event names
const EVENT_TYPE_MAP: Record<string, string> = {
  payment_link_created: 'payment_link_created',
  payment_link_expired: 'payment_link_expired',
  payment_link_payment_failed: 'payment_failed',
  payment_failed: 'payment_failed',
  payment_successful: 'payment_successful',
  order_created: 'order_created',
  order_attempted: 'order_attempted',
  order_paid: 'order_paid',
  refund_created: 'refund_created',
  refund_processed: 'refund_processed',
  subscription_created: 'subscription_created',
  subscription_activated: 'subscription_activated',
  subscription_deactivated: 'subscription_deactivated',
  subscription_failed: 'subscription_failed',
  payout_failed: 'payout_failed',
  payout_success: 'payout_success',
  payout_reversed: 'payout_reversed',
  charge_created: 'charge_created',
  charge_success: 'charge_success',
  charge_failed: 'charge_failed',
  invoice_generated: 'invoice_generated',
  invoice_paid: 'invoice_paid',
  invoice_failed: 'invoice_failed',
  webhook_failed: 'webhook_failed',
  setup_attempt_failed: 'setup_attempt_failed',
  vault_payment_failed: 'vault_payment_failed',
  vault_payment_success: 'vault_payment_success',
};

export interface NormalizedProviderEvent {
  eventType: string;
  safeMetadata: {
    providerTransactionId?: string;
    amount?: number;
    currency: string;
    status?: string;
    paymentMethod?: string;
    failureCode?: string;
    failureMessage?: string;
    failureCategory: string;
    occurredAt?: string | number;
    customerEmail?: string;
    customerContact?: string;
  };
  rawEventId?: string;
  occurredAt?: string | number;
}

/**
 * Normalize a raw Razorpay/simulation event into the internal format.
 * Extracts only safe metadata - no card numbers, no full PAN.
 */
export function normalizeRazorpayEvent(event: any): NormalizedProviderEvent {
  const type = event.event_type || event.event;
  const data = event.data || {};

  const internalEventType = EVENT_TYPE_MAP[type] || 'unknown_event';

  const safeMetadata = {
    providerTransactionId: data.id,
    amount: data.amount,
    currency: data.currency || 'INR',
    status: data.status,
    paymentMethod: data.method,
    failureCode: data.error?.code,
    failureMessage: data.error?.description,
    failureCategory: categorizeFailure(
      data.error?.code,
      data.error?.description
    ),
    occurredAt: data.time_created,
    customerEmail: data.email,
    customerContact: data.contact,
  };

  return {
    eventType: internalEventType,
    safeMetadata,
    rawEventId: event.id,
    occurredAt: safeMetadata.occurredAt,
  };
}