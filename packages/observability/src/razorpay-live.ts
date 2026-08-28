/**
 * LIVE recovery dispatch against the real Razorpay Payments API.
 *
 * The live branch of the action executor must never fabricate a provider
 * reference. Either a REAL Razorpay Payment Link is created (and its real
 * `id`/`short_url` used) or the action is recorded honestly without any
 * provider reference — never a made-up `live_<timestamp>` id.
 *
 * Only payment-collection action types get a Payment Link. Notification /
 * outreach action types (timed_reminder, human_escalation) have no Razorpay
 * API dispatch in this MVP and are recorded as executed locally.
 */
import { prisma } from '../../database';
import { decryptSecret } from './encryption';

export const PAYMENT_LINK_ACTION_TYPES = new Set([
  'retry_later',
  'payment_method_recovery',
  'checkout_recovery',
  'subscription_recovery',
]);

export interface DispatchParams {
  merchantId: string;
  actionType: string;
  amountPaise: number;
  currency: string;
  description?: string;
  customerEmail?: string;
  customerPhone?: string;
  caseRef?: string;
}

export interface LiveDispatchOutcome {
  status: 'dispatched' | 'recorded' | 'error';
  providerActionId?: string;
  paymentUrl?: string;
  error?: string;
}

async function resolveLiveCredentials(merchantId: string): Promise<{
  keyId: string;
  keySecret: string;
} | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { merchantId, provider: 'razorpay', status: 'active' },
    orderBy: { id: 'desc' },
  });
  if (conn?.keyId && conn.keySecretEncrypted) {
    const secret = decryptSecret(conn.keySecretEncrypted);
    if (secret) return { keyId: conn.keyId, keySecret: secret };
  }
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    return {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
    };
  }
  return null;
}

export async function dispatchLiveAction(
  params: DispatchParams
): Promise<LiveDispatchOutcome> {
  // Notification / outreach actions have no Razorpay API dispatch in the MVP.
  // They are honestly recorded as executed (no provider reference, no payment
  // charged, no fabricated id).
  if (!PAYMENT_LINK_ACTION_TYPES.has(params.actionType)) {
    return { status: 'recorded' };
  }

  const creds = await resolveLiveCredentials(params.merchantId);
  if (!creds) {
    return {
      status: 'error',
      error:
        'Live execution requires Razorpay API credentials. Connect Key ID + Key Secret on /integrations (stored encrypted) or set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
    };
  }

  if (!Number.isFinite(params.amountPaise) || params.amountPaise < 100) {
    return {
      status: 'error',
      error: `Razorpay cannot create a payment link for ${params.amountPaise} paise (minimum ₹1).`,
    };
  }

  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  const customer: Record<string, string> = {};
  if (params.customerEmail) customer.email = params.customerEmail;
  if (params.customerPhone) customer.contact = params.customerPhone;

  try {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: params.amountPaise,
        currency: params.currency || 'INR',
        accept_partial: false,
        description: params.description || 'RevenuePulse recovery payment',
        customer: Object.keys(customer).length ? customer : undefined,
        notes: params.caseRef ? { case_ref: params.caseRef } : undefined,
        remind_enable: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        status: 'error',
        error: `Razorpay rejected payment-link creation (HTTP ${res.status}): ${text.slice(0, 300)}`,
      };
    }

    const link = await res.json();
    const providerActionId = typeof link?.id === 'string' ? link.id : null;
    const paymentUrl = typeof link?.short_url === 'string' ? link.short_url : null;
    if (!providerActionId) {
      return { status: 'error', error: 'Razorpay payment link response missing id.' };
    }
    return { status: 'dispatched', providerActionId, paymentUrl: paymentUrl ?? undefined };
  } catch (e: any) {
    return {
      status: 'error',
      error: `Could not reach api.razorpay.com: ${e?.message ?? 'network error'}`,
    };
  }
}