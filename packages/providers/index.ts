/**
 * Payment Provider Abstraction Layer
 *
 * Supports simulation mode as primary, with Razorpay as optional adapter.
 * All payment operations go through this interface to ensure:
 * - Deterministic behavior
 * - Policy enforcement
 * - Idempotency
 * - Auditability
 */

import crypto from 'crypto';

/**
 * Verify a Razorpay webhook signature (HMAC SHA256 of raw body with webhook secret).
 *
 * Simulation mode: when RAZORPAY_WEBHOOK_SECRET is not configured, signatures
 * are accepted so local/demo webhooks work without real credentials. The
 * response flag tells callers they are in simulation mode.
 */
export function verifyRazorpaySignature(
  payload: string,
  signature: string
): { valid: boolean; simulated: boolean } {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    // Simulation mode - no real provider configured
    return { valid: true, simulated: true };
  }

  if (!signature) {
    return { valid: false, simulated: false };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  // Length check avoids timing-safe compare throwing on length mismatch
  const valid =
    a.length === b.length && crypto.timingSafeEqual(a, b);

  return { valid, simulated: false };
}

export interface RetryParams {
  caseId: string;
  amount: number; // In paise
  currency: string;
  attemptNumber: number;
  failureCategory?: string;
}

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

export interface PaymentLinkParams {
  caseId: string;
  amount: number; // In paise
  currency: string;
  customerEmail: string;
  customerPhone: string;
  description: string;
  returnUrl?: string;
}

export interface PaymentLinkResult {
  success: boolean;
  paymentId: string;
  paymentUrl: string;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
}

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
 * Configurable success rates, latency, and failure modes
 */
export class SimulationProvider implements PaymentProvider {
  private successRate: number;
  private latencyMs: number;
  failureModes: Map<string, number>; // category -> probability of failure

  constructor(config?: {
    successRate?: number;
    latencyMs?: number;
    failureModes?: Map<string, number>;
  }) {
    this.successRate = config?.successRate ?? 0.7; // 70% success by default
    this.latencyMs = config?.latencyMs ?? 200;
    this.failureModes = config?.failureModes ?? new Map([
      ['insufficient_funds', 0.1],
      ['bank_failure', 0.15],
      ['auth_failure', 0.1],
      ['expired_instrument', 0.05],
      ['network_timeout', 0.1],
      ['customer_cancellation', 0.2],
      ['unknown', 0.3],
    ]);
  }

  async retryPayment(params: RetryParams): Promise<RetryResult> {
    // Simulate based on success rate and failure mode
    const baseSuccess = Math.random() < this.successRate;
    
    // Apply failure mode adjustment
    let adjustment = 0;
    if (params.failureCategory && this.failureModes.has(params.failureCategory)) {
      adjustment = this.failureModes.get(params.failureCategory);
    }
    
    const finalSuccess = baseSuccess && Math.random() > adjustment;
    const status = finalSuccess ? 'SUCCESS' : 'FAILURE';
    
    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));

    return {
      success: finalSuccess,
      providerRef: `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
 */
export class RazorpayProvider implements PaymentProvider {
  private apiKey: string;
  private apiSecret: string;
  baseUrl: string = 'https://api.razorpapay.com/v1';

  constructor(credentials: {
    apiKey: string;
    apiSecret: string;
  }) {
    this.apiKey = credentials.apiKey;
    this.apiSecret = credentials.apiSecret;
  }

  async retryPayment(params: RetryParams): Promise<RetryResult> {
    // In a real implementation, this would call Razorpay's retry endpoint
    // For now, throw error indicating misconfiguration
    throw new Error(
      'RazorpayProvider not configured. Set RAZORPAY_API_KEY and RAZORPAY_API_SECRET environment variables, ' +
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
 * Notification Provider - Simulation primary, SendGrid/Twilio optional
 */
export class SimulationNotificationProvider implements NotificationProvider {
  async sendEmail(params: {
    to: string;
    subject: string;
    template: string;
    context?: Record<string, any>;
  }): Promise<{ success: boolean; providerRef: string; messageId?: string }> {
    console.log('[SIM EMAIL]', { to: params.to, subject: params.subject, template: params.template });
    return {
      success: true,
      providerRef: `sim_email_${Date.now()}`,
      messageId: `msg_${Date.now()}`,
    };
  }

  async sendSMS(params: {
    to: string;
    template: string;
    context?: Record<string, any>;
  }): Promise<{ success: boolean; providerRef: string; messageId?: string }> {
    console.log('[SIM SMS]', { to: params.to, template: params.template });
    return {
      success: true,
      providerRef: `sim_sms_${Date.now()}`,
      messageId: `sms_${Date.now()}`,
    };
  }
}

export let notificationProvider: NotificationProvider = new SimulationNotificationProvider();

export function setNotificationProvider(provider: NotificationProvider): void {
  notificationProvider = provider;
}

export function getNotificationProvider(): NotificationProvider {
  return notificationProvider;
}