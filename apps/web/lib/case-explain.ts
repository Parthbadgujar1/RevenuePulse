/**
 * Plain-language helpers for the case detail page.
 * Converts technical failure codes and actions into sentences a human
 * without engineering background can understand.
 */

/** Explain what went wrong in simple terms — uses ACTUAL data from the diagnosis. */
export function plainFailureExplanation(
  diag: Record<string, unknown>,
  tx: Record<string, unknown> | null,
): string {
  const method = tx?.paymentMethod ? String(tx.paymentMethod).replace(/_/g, ' ') : 'payment';
  const code = String(diag.failureCode ?? '').toUpperCase();
  const category = String(diag.primaryCategory ?? '').toLowerCase();
  const rawMessage = String(diag.failureMessage ?? '');

  // If the system has no real failure data, say so honestly
  if (!code && !rawMessage && (category === 'unknown' || !category)) {
    return `This ${method} payment failed, but the exact reason wasn't captured. This can happen when the payment gateway didn't report a specific error. The payment was not deducted from the customer's account.`;
  }

  // Build explanation from ACTUAL Razorpay failure data
  const failureDetails = buildFailureDetail(code, rawMessage, category, method);
  const whoFailed = identifyWhoFailed(code, category);

  return `${whoFailed} — ${failureDetails}`;
}

/** Identify who/what caused the failure. */
function identifyWhoFailed(code: string, category: string): string {
  // Bank-side failures
  if (['RA0002', 'RA0003', 'RA0004', 'RA0005', 'RA0006', 'RA0007', 'RA0008', 'RA0010', 'RA0011', 'RA0014', 'RA0015', 'RA0016'].includes(code) ||
      category === 'bank_failure') {
    return 'The customer\'s bank declined this payment';
  }

  // Authentication failures
  if (code === 'AUTH_ERROR' || code === 'AUTHENTICATION_FAILED' || category === 'auth_failure') {
    return 'The customer\'s bank required extra authentication (OTP/2FA) that wasn\'t completed';
  }

  // Insufficient funds
  if (code === 'INSUFFICIENT_FUNDS' || category === 'insufficient_funds') {
    return 'The customer\'s account didn\'t have enough balance';
  }

  // Card issues
  if (code === 'CARD_EXPIRED' || category === 'expired_instrument') {
    return 'The card used has expired and can no longer be charged';
  }

  // Network issues
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR' || category === 'network_timeout') {
    return 'A network timeout occurred between Razorpay and the bank';
  }

  // Customer-initiated
  if (code === 'PAYMENT_CANCELLED' || code === 'CUSTOMER_CANCELLED' || category === 'customer_cancellation') {
    return 'The customer cancelled or closed the payment before it completed';
  }

  // Repeated attempt
  if (code === 'REPEATED_ATTEMPT' || category === 'repeated_failure') {
    return 'The bank flagged this as a repeated failed attempt and blocked it';
  }

  // Generic bank decline
  if (category === 'bank_failure') {
    return 'The customer\'s bank declined this payment';
  }

  return 'The payment failed at the bank level';
}

/** Build a detailed failure explanation from actual data. */
function buildFailureDetail(code: string, rawMessage: string, category: string, method: string): string {
  // Use the actual failure message from Razorpay when available
  const hasRealMessage = rawMessage && !rawMessage.toLowerCase().includes('unknown') && rawMessage.length > 3;

  const specificReasons: Record<string, string> = {
    INSUFFICIENT_FUNDS: `The customer's account doesn't have enough money to complete this ₹${method} payment.`,
    RA0002: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} This is a bank-side issue — the customer needs to contact their bank.`,
    RA0003: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} This is a bank-side issue.`,
    RA0004: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer should try a different payment method.`,
    RA0005: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer should contact their bank.`,
    RA0006: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer's card may be blocked for online transactions.`,
    RA0007: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer's card has restrictions.`,
    RA0008: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} Possible card network issue.`,
    RA0010: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer should contact their bank.`,
    RA0011: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The bank doesn't support this transaction type.`,
    RA0014: `The bank declined the transaction. ${hasRealMessage ? `Bank says: "${rawMessage}".` : ''} This could be a temporary bank restriction.`,
    RA0015: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} The customer may need to verify their card with the bank.`,
    RA0016: `The bank returned an error. ${hasRealMessage ? `Razorpay says: "${rawMessage}".` : ''} Possible fraud prevention block.`,
    AUTH_ERROR: `The customer didn't complete the bank's authentication step (OTP or 2FA). The payment was abandoned before the bank could process it.`,
    CARD_EXPIRED: `The card used has an expiry date that has passed. The customer needs to use a different card.`,
    TIMEOUT: `The bank took too long to respond. This is usually temporary — the payment may still go through, or the customer can retry.`,
    REPEATED_ATTEMPT: `The bank detected multiple failed attempts and temporarily blocked this card. The customer should wait a few hours or use a different payment method.`,
    PAYMENT_CANCELLED: `The customer closed the payment page before completing the transaction. No money was deducted.`,
    CUSTOMER_CANCELLED: `The customer cancelled the payment. No money was deducted.`,
  };

  if (specificReasons[code]) {
    return specificReasons[code];
  }

  // Fall back to the actual message from Razorpay
  if (hasRealMessage) {
    return `The ${method} payment failed: "${rawMessage}". ${category === 'bank_failure' ? 'The customer should contact their bank or try a different payment method.' : ''}`;
  }

  // Last resort — use category
  const categoryMessages: Record<string, string> = {
    bank_failure: `The customer's bank declined this ${method} payment. The customer should contact their bank or try a different payment method.`,
    auth_failure: `The bank required extra authentication (OTP/2FA) for this ${method} payment, but it wasn't completed.`,
    insufficient_funds: `The customer's account doesn't have enough balance for this ${method} payment.`,
    network_timeout: `A network timeout occurred while processing the ${method} payment. This is usually temporary.`,
    expired_instrument: `The payment instrument (card/UPI) used has expired or is no longer valid.`,
    customer_cancellation: `The customer cancelled the ${method} payment before it was processed.`,
    repeated_failure: `The bank flagged this as a repeated failed attempt and blocked it.`,
  };

  return categoryMessages[category] ?? `The ${method} payment failed. No specific error details were captured.`;
}

/** Explain what the AI recommends in simple terms. */
export function plainActionExplanation(
  actionType: string | null,
  probability: number,
  amount: number,
  attemptCount: number,
  maxAttempts: number,
): string {
  const pct = (probability * 100).toFixed(0);
  const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount / 100);

  switch ((actionType || '').toLowerCase()) {
    case 'retry_later':
      return `The AI gives this payment a ${pct}% chance of succeeding if we try again. We've attempted ${attemptCount} of ${maxAttempts} allowed retries. The system recommends retrying the payment in a few hours — banks often approve retries after initial failures.`;
    case 'timed_reminder':
      return `The AI recommends sending your customer a reminder to retry the payment. A ${pct}% recovery chance makes a gentle nudge worthwhile.`;
    case 'payment_method_recovery':
      return `The AI suggests asking the customer to update their payment method (e.g., try a different card or UPI). This often works when the original method keeps failing.`;
    case 'human_escalation':
      return `This case needs your personal attention. The amount or complexity is beyond what the AI can handle automatically.`;
    case 'do_nothing':
      return `The AI recommends not taking further action on this payment — the expected cost of recovery outweighs the amount at risk.`;
    default:
      if (probability >= 0.5) {
        return `The AI gives this payment a ${pct}% chance of recovery. Based on this probability and the amount at stake (${inrFmt}), it recommends trying to recover the payment.`;
      }
      return `The AI gives this payment a ${pct}% chance of recovery — below the threshold for automated action. You can still intervene manually if you'd like.`;
  }
}

/** Explain what a specific outcome means in simple terms. */
export function plainOutcomeExplanation(
  result: string,
  recoveredAmount: number,
  measuredCost: number,
  notes: string | null,
): string {
  if (result === 'RECOVERED') {
    const net = recoveredAmount - measuredCost;
    return `Great news — ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(recoveredAmount / 100)} was recovered! After deducting the recovery cost, your net gain is ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(net / 100)}.`;
  }
  if (result === 'ADMIN_CONFIRMED_RECOVERY') {
    const net = recoveredAmount - measuredCost;
    return `Confirmed as recovered by admin — ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(recoveredAmount / 100)} recovered, ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(net / 100)} net. This was manually confirmed, not auto-verified by a provider event.`;
  }
  if (notes?.includes('verification_timeout')) {
    return `The payment provider did not send a result within the expected timeframe. This usually means the payment is unlikely to succeed. You can mark this as failed or check Razorpay directly.`;
  }
  return `The recovery attempt was unsuccessful${notes ? ` — ${notes}` : ''}. You can accept this result, or try again if you think the payment might still go through.`;
}

/** Suggest which admin actions make sense for the current case state. */
export function suggestedAdminActions(
  status: string,
  actionType: string | null,
  probability: number,
  attemptCount: number,
  maxAttempts: number,
): Array<{ action: string; label: string; description: string; variant: 'primary' | 'secondary' | 'danger' }> {
  const remaining = maxAttempts - attemptCount;
  const pct = (probability * 100).toFixed(0);

  if (status === 'FAILED' || status === 'STOPPED') {
    const actions = [
      {
        action: 'retry',
        label: 'Try Again',
        description: remaining > 0
          ? `Re-analyze this payment and propose a new plan. You'll review before anything runs. ${pct}% chance of success. ${remaining} attempt(s) remaining.`
          : `Re-analyze this payment. Max retries reached — this overrides the limit.`,
        variant: 'primary' as const,
      },
      {
        action: 'request_refund',
        label: 'Refund Customer',
        description: `If money was deducted from the customer's account but not received by you, initiate a refund to return it to them.`,
        variant: 'secondary' as const,
      },
      {
        action: 'accept',
        label: 'Accept Result',
        description: `Close this case permanently. The payment will not be retried and no refund will be issued.`,
        variant: 'secondary' as const,
      },
    ];
    return actions;
  }

  if (status === 'OUTCOME_PENDING') {
    return [
      {
        action: 'mark_recovered',
        label: 'Mark as Recovered',
        description: `If you've confirmed in Razorpay that the payment went through, mark it as recovered now.`,
        variant: 'primary' as const,
      },
      {
        action: 'mark_failed',
        label: 'Mark as Failed',
        description: `If you've confirmed the payment did not go through, close this case.`,
        variant: 'danger' as const,
      },
    ];
  }

  if (status === 'ACTION_PENDING' || status === 'RECOVERY_IN_PROGRESS') {
    return [
      {
        action: 'cancel',
        label: 'Cancel Action',
        description: `Stop the current recovery action. The case will remain open for manual review.`,
        variant: 'danger' as const,
      },
    ];
  }

  return [];
}
