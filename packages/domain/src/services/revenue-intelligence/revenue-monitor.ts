// Revenue Monitor - Aggregates transaction events and calculates
// revenue at risk across a merchant's portfolio

import { FailureCategory } from '../../constants/failure-taxonomy';
import { diagnoseFailure } from '../domain-services';

// Type for aggregated revenue data
export interface RevenueAtRisk {
  totalAtRisk: number; // in paise
  totalRecoverable: number; // in paise
  totalLost: number; // in paise
  byFailureCategory: Record<FailureCategory, number>;
  byStatus: Record<string, number>;
  byPaymentMethod: Record<string, number>;
  recoverabilityDistribution: Record<FailureCategory, number>;
  trend: 'improving' | 'stable' | 'degrading' | 'unknown';
  lastUpdated: Date;
  timeWindow: {
    start: Date;
    end: Date;
  };
}

// Transaction summary for monitoring
export interface TransactionSummary {
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: string;
  failureCategory?: FailureCategory;
  failureCode?: string;
  failureMessage?: string;
  occurredAt: Date;
  paymentMethod: string;
  merchantId: string;
  daysSinceFailure: number;
  recoverability: number; // 0-1
}

// Aggregate transactions into revenue-at-risk calculation
export function aggregateRevenueAtRisk(
  transactions: TransactionSummary[],
  now: Date = new Date()
): RevenueAtRisk {
  const totalAtRisk = transactions.reduce(
    (sum, t) => sum + (t.status === 'failed' ? t.amount : 0),
    0
  );

  const totalRecoverable = transactions.reduce(
    (sum, t) => sum + (t.status === 'failed' && t.recoverability > 0 ? t.amount * t.recoverability : 0),
    0
  );

  const totalLost = transactions.reduce(
    (sum, t) => sum + (t.status === 'failed' ? t.amount : 0),
    0
  );

  // Aggregate by failure category
  const byFailureCategory: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0,
    [FailureCategory.BANK_FAILURE]: 0,
    [FailureCategory.AUTH_FAILURE]: 0,
    [FailureCategory.EXPIRED_INSTRUMENT]: 0,
    [FailureCategory.NETWORK_TIMEOUT]: 0,
    [FailureCategory.CUSTOMER_CANCELLATION]: 0,
    [FailureCategory.UNKNOWN]: 0,
    [FailureCategory.REPEATED_FAILURE]: 0,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0,
  };

  // Aggregate by status
  const byStatus: Record<string, number> = {};
  // Aggregate by payment method
  const byPaymentMethod: Record<string, number> = {};

  // Track recoverability per category
  const recoverabilityDistribution: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0,
    [FailureCategory.BANK_FAILURE]: 0,
    [FailureCategory.AUTH_FAILURE]: 0,
    [FailureCategory.EXPIRED_INSTRUMENT]: 0,
    [FailureCategory.NETWORK_TIMEOUT]: 0,
    [FailureCategory.CUSTOMER_CANCELLATION]: 0,
    [FailureCategory.UNKNOWN]: 0,
    [FailureCategory.REPEATED_FAILURE]: 0,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0,
  };

  for (const t of transactions) {
    if (t.failureCategory && byFailureCategory[t.failureCategory] !== undefined) {
      byFailureCategory[t.failureCategory] = (
        byFailureCategory[t.failureCategory] || 0
      ) + t.amount;
    }

    byStatus[t.status] = (byStatus[t.status] || 0) + 1;

    if (t.paymentMethod) {
      byPaymentMethod[t.paymentMethod] = (byPaymentMethod[t.paymentMethod] || 0) + t.amount;
    }

    if (t.failureCategory && recoverabilityDistribution[t.failureCategory] !== undefined) {
      recoverabilityDistribution[t.failureCategory] = (
        recoverabilityDistribution[t.failureCategory] || 0
      ) + t.recoverability * t.amount;
    }
  }

  // Determine trend (simple comparison vs prior period)
  const trend = determineTrend(transactions);

  return {
    totalAtRisk,
    totalRecoverable,
    totalLost,
    byFailureCategory,
    byStatus,
    byPaymentMethod,
    recoverabilityDistribution,
    trend,
    lastUpdated: now,
    timeWindow: {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1), // prior month
      end: now,
    },
  };
}

// Determine trend based on failure rate comparison
function determineTrend(transactions: TransactionSummary[]): 'improving' | 'stable' | 'degrading' | 'unknown' {
  const failedThisPeriod = transactions.filter(t => t.status === 'failed').length;
  const totalThisPeriod = transactions.length;
  const failureRate = totalThisPeriod > 0 ? failedThisPeriod / totalThisPeriod : 0;

  // In a full implementation, this would compare vs prior period
  // For now, use simple heuristics
  if (failureRate > 0.3) return 'degrading';
  if (failureRate > 0.15) return 'stable';
  if (failureRate > 0) return 'improving';
  return 'unknown';
}

// Create a transaction summary from a Prisma Transaction model
export function transactionToSummary(transaction: any): TransactionSummary {
  // Diagnose the failure category
  let failureCategory: FailureCategory = FailureCategory.UNKNOWN;
  let recoverability = 0.5; // default

  if (transaction.failureCategory) {
    failureCategory = transaction.failureCategory as FailureCategory;
  } else if (transaction.failureCode || transaction.failureMessage) {
    // Attempt to diagnose from code/message
    const diagnosis = diagnoseFailure(
      transaction.failureCode || '',
      transaction.failureMessage || '',
      transaction.failureCategory as string | undefined
    );
    failureCategory = diagnosis.primaryCategory;
  }

  // Calculate recoverability based on category and other factors
  recoverability = calculateRecoverability(failureCategory, transaction.attemptCount || 0);

  return {
    providerTransactionId: transaction.providerTransactionId,
    amount: transaction.amount,
    currency: transaction.currency,
    status: transaction.status,
    failureCategory,
    failureCode: transaction.failureCode,
    failureMessage: transaction.failureMessage,
    occurredAt: transaction.occurredAt || new Date(),
    paymentMethod: transaction.paymentMethod || 'unknown',
    merchantId: transaction.merchantId || '',
    daysSinceFailure: transaction.status === 'failed'
      ? Math.floor((new Date().getTime() - (transaction.occurredAt || new Date()).getTime()) / (1000 * 60 * 60 * 24))
      : 0,
    recoverability,
  };
}

// Calculate recoverability based on failure category and attempt count
function calculateRecoverability(
  category: FailureCategory,
  attemptCount: number
): number {
  // Base recoverability by category
  const baseRecoverability: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0.75,
    [FailureCategory.BANK_FAILURE]: 0.65,
    [FailureCategory.AUTH_FAILURE]: 0.80,
    [FailureCategory.EXPIRED_INSTRUMENT]: 0.30,
    [FailureCategory.NETWORK_TIMEOUT]: 0.85,
    [FailureCategory.CUSTOMER_CANCELLATION]: 0.10,
    [FailureCategory.UNKNOWN]: 0.50,
    [FailureCategory.REPEATED_FAILURE]: 0.40,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0.60,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0.55,
  };

  const base = baseRecoverability[category] || 0.5;

  // Each additional attempt reduces recoverability
  const attemptPenalty = Math.min(0.15 * attemptCount, 0.5);

  return Math.max(0.01, Math.min(0.99, base - attemptPenalty));
}

// Detect degradation patterns across transactions
export function detectDegradation(
  transactions: TransactionSummary[],
  threshold: number = 0.15
): {
  isDegrading: boolean;
  degradationRate: number;
  affectedCategories: FailureCategory[];
  timeWindow: { start: Date; end: Date };
  recommendations: string[];
} {
  const total = transactions.length;
  if (total === 0) {
    return {
      isDegrading: false,
      degradationRate: 0,
      affectedCategories: [],
      timeWindow: { start: new Date(), end: new Date() },
      recommendations: [],
    };
  }

  const failed = transactions.filter(t => t.status === 'failed');
  const failureRate = failed.length / total;

  // Find categories with elevated failure rates
  const categoryCounts: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0,
    [FailureCategory.BANK_FAILURE]: 0,
    [FailureCategory.AUTH_FAILURE]: 0,
    [FailureCategory.EXPIRED_INSTRUMENT]: 0,
    [FailureCategory.NETWORK_TIMEOUT]: 0,
    [FailureCategory.CUSTOMER_CANCELLATION]: 0,
    [FailureCategory.UNKNOWN]: 0,
    [FailureCategory.REPEATED_FAILURE]: 0,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0,
  };

  const categoryFailed: Record<FailureCategory, number> = {
    [FailureCategory.INSUFFICIENT_FUNDS]: 0,
    [FailureCategory.BANK_FAILURE]: 0,
    [FailureCategory.AUTH_FAILURE]: 0,
    [FailureCategory.EXPIRED_INSTRUMENT]: 0,
    [FailureCategory.NETWORK_TIMEOUT]: 0,
    [FailureCategory.CUSTOMER_CANCELLATION]: 0,
    [FailureCategory.UNKNOWN]: 0,
    [FailureCategory.REPEATED_FAILURE]: 0,
    [FailureCategory.PAYMENT_METHOD_DEGRADATION]: 0,
    [FailureCategory.SUBSCRIPTION_FAILURE]: 0,
  };

  for (const t of failed) {
    if (t.failureCategory && categoryCounts[t.failureCategory] !== undefined) {
      categoryCounts[t.failureCategory]++;
      if (t.failureCategory && categoryFailed[t.failureCategory] !== undefined) {
        categoryFailed[t.failureCategory]++;
      }
    }
  }

  // Find categories with failure rate above threshold
  const affectedCategories: FailureCategory[] = [];
  for (const [cat, count] of Object.entries(categoryCounts)) {
    const catFailed = categoryFailed[cat] || 0;
    const catRate = total > 0 ? catFailed / failed.length : 0;
    // If this category represents more than threshold of failures
    if (catRate > threshold && count > 5) {
      affectedCategories.push(cat as FailureCategory);
    }
  }

  // Sort by failure count (most severe first)
  affectedCategories.sort((a, b) => {
    const aFailed = categoryFailed[a] || 0;
    const bFailed = categoryFailed[b] || 0;
    return bFailed - aFailed;
  });

  // Recommendations based on affected categories
  const recommendations: string[] = [];

  if (affectedCategories.includes(FailureCategory.BANK_FAILURE)) {
    recommendations.push(
      'Investigate bank partner stability; consider alternative payment methods'
    );
  }
  if (affectedCategories.includes(FailureCategory.EXPIRED_INSTRUMENT)) {
    recommendations.push(
      'Launch payment method update campaign; set up expiry alerts'
    );
  }
  if (affectedCategories.includes(FailureCategory.NETWORK_TIMEOUT)) {
    recommendations.push(
      'Implement retry logic with exponential backoff; review network routes'
    );
  }
  if (affectedCategories.includes(FailureCategory.REPEATED_FAILURE)) {
    recommendations.push(
      'Run pattern analysis on repeated failures; may indicate systemic issue'
    );
  }
  if (affectedCategories.length === 0) {
    recommendations.push('No specific degradation detected; monitor continuing trends');
  }

  return {
    isDegrading: failureRate > threshold && affectedCategories.length > 0,
    degradationRate: failureRate,
    affectedCategories,
    timeWindow: {
      start: transactions.length > 0
        ? new Date(Math.min(...transactions.map((t) => t.occurredAt!.getTime())))
        : new Date(),
      end: new Date(),
    },
    recommendations,
  };
}