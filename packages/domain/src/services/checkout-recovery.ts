// Checkout Abandonment Recovery
// Pure business logic for recovering abandoned checkout sessions

export interface CheckoutRecoveryFeatures {
  /** Unique checkout session identifier */
  sessionId: string;
  /** Cart value in paise */
  amount: number;
  /** Customer email for contact */
  customerEmail: string;
  /** Reason checkout was abandoned */
  abandonmentReason: 'payment_failed' | 'timeout' | 'user_exit' | 'network_error';
  /** Hours since abandonment occurred */
  timeSinceAbandonmentHours: number;
  /** Total cart value in paise */
  cartValue: number;
  /** Number of items in cart */
  itemCount: number;
  /** Number of previous successful purchases */
  previousPurchases: number;
  /** Customer segment classification */
  customerSegment: 'new' | 'returning' | 'vip' | 'at_risk';
}

export interface CheckoutRecoveryPrediction {
  /** Probability of recovery (0-1) */
  probability: number;
  /** Recommended incentive to recover */
  recommendedIncentive: IncentiveRecommendation;
}

export interface IncentiveRecommendation {
  /** Type of incentive offered */
  type: 'discount' | 'free_shipping' | 'coupon' | 'loyalty_points' | 'none';
  /** Incentive value (percentage or absolute in paise) */
  value: number;
  /** Human-readable reasoning for the recommendation */
  reasoning: string;
}

// Baseline abandonment rates by reason
export const CHECKOUT_ABANDONMENT_RATES: Record<string, number> = {
  payment_failed: 0.65,
  timeout: 0.45,
  user_exit: 0.30,
  network_error: 0.70,
};

// Incentive effectiveness lift by type and abandonment reason
// Values represent probability multipliers (1.0 = no lift)
export const INCENTIVE_EFFECTIVENESS: Record<string, Record<string, number>> = {
  discount: {
    payment_failed: 1.40,
    timeout: 1.25,
    user_exit: 1.15,
    network_error: 1.30,
  },
  free_shipping: {
    payment_failed: 1.20,
    timeout: 1.30,
    user_exit: 1.35,
    network_error: 1.15,
  },
  coupon: {
    payment_failed: 1.25,
    timeout: 1.15,
    user_exit: 1.20,
    network_error: 1.10,
  },
  loyalty_points: {
    payment_failed: 1.10,
    timeout: 1.10,
    user_exit: 1.05,
    network_error: 1.05,
  },
};

// Segment multipliers for recovery probability
const SEGMENT_MULTIPLIERS: Record<string, number> = {
  new: 0.80,
  returning: 1.00,
  vip: 1.25,
  at_risk: 0.60,
};

// Calculate checkout recovery probability
export function calculateCheckoutRecoveryProbability(
  features: CheckoutRecoveryFeatures
): CheckoutRecoveryPrediction {
  const baseRate =
    CHECKOUT_ABANDONMENT_RATES[features.abandonmentReason] || 0.5;

  // Time decay: probability drops 5% per hour after first hour
  const timeDecay = Math.max(0.1, 1.0 - 0.05 * Math.max(0, features.timeSinceAbandonmentHours - 1));

  // Cart value factor: higher value = slightly more likely to recover
  const valueFactor = Math.min(1.3, 1.0 + Math.log(features.cartValue / 1000 + 1) * 0.08);

  // Item count factor: more items = more invested
  const itemFactor = Math.min(1.2, 1.0 + (features.itemCount - 1) * 0.05);

  // Previous purchases factor
  const purchaseFactor = Math.min(1.3, 1.0 + features.previousPurchases * 0.03);

  // Segment multiplier
  const segmentMultiplier = SEGMENT_MULTIPLIERS[features.customerSegment] || 1.0;

  let probability =
    baseRate * timeDecay * valueFactor * itemFactor * purchaseFactor * segmentMultiplier;

  probability = Math.max(0.01, Math.min(0.99, probability));

  const recommendedIncentive = selectIncentive(features, probability);

  return { probability, recommendedIncentive };
}

// Select best incentive type based on features and probability
export function selectIncentive(
  features: CheckoutRecoveryFeatures,
  probability: number
): IncentiveRecommendation {
  if (probability >= 0.7) {
    return {
      type: 'none',
      value: 0,
      reasoning: 'High recovery probability; no incentive needed.',
    };
  }

  if (features.customerSegment === 'vip') {
    return {
      type: 'loyalty_points',
      value: Math.floor(features.cartValue * 0.05),
      reasoning: 'VIP customer: reward with loyalty points instead of discount.',
    };
  }

  const reason = features.abandonmentReason;

  if (reason === 'payment_failed' || reason === 'network_error') {
    if (features.cartValue > 500000) {
      return {
        type: 'discount',
        value: Math.floor(features.cartValue * 0.10),
        reasoning:
          'High cart value with payment/network issue: 10% discount to overcome friction.',
      };
    }
    return {
      type: 'free_shipping',
      value: 0,
      reasoning:
        'Payment or network failure: free shipping reduces perceived risk.',
    };
  }

  if (reason === 'timeout') {
    return {
      type: 'coupon',
      value: Math.floor(features.cartValue * 0.05),
      reasoning:
        'Timeout abandonment: 5% coupon for next attempt to re-engage.',
    };
  }

  // user_exit
  if (features.previousPurchases === 0) {
    return {
      type: 'discount',
      value: Math.floor(features.cartValue * 0.15),
      reasoning:
        'New customer exit: aggressive 15% discount to secure first purchase.',
    };
  }

  return {
    type: 'coupon',
    value: Math.floor(features.cartValue * 0.08),
    reasoning: 'Returning customer exit: 8% coupon to re-engage.',
  };
}
