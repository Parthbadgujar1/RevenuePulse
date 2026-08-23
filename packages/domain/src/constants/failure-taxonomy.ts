// Failure Taxonomy - Normalized categories for payment failures
// These are the structured internal categories, NOT free-form LLM output

export enum FailureCategory {
  INSUFFICIENT_FUNDS = 'insufficient_funds',
  BANK_FAILURE = 'bank_failure',
  AUTH_FAILURE = 'auth_failure',
  EXPIRED_INSTRUMENT = 'expired_instrument',
  NETWORK_TIMEOUT = 'network_timeout',
  CUSTOMER_CANCELLATION = 'customer_cancellation',
  UNKNOWN = 'unknown',
  REPEATED_FAILURE = 'repeated_failure',
  PAYMENT_METHOD_DEGRADATION = 'payment_method_degradation',
  SUBSCRIPTION_FAILURE = 'subscription_failure',
}

// Failure category metadata for pattern detection
export interface FailureCategoryMetadata {
  name: FailureCategory;
  displayName: string;
  description: string;
  isTransient: boolean;
  typicalRecoveryProbability: number; // 0-1 range
  stoppingRule: 'none' | 'max_attempts' | 'customer_decline' | 'policy_block';
}

// Failure pattern detection results
export interface FailurePattern {
  category: FailureCategory;
  count: number;
  percentage: number;
  timeWindow?: {
    start: number; // hour of day (0-23)
    end: number;
  };
  paymentMethod?: string;
  customerSegment?: string;
}

// Aggregated failure statistics
export interface FailureStatistics {
  totalFailures: number;
  byCategory: Record<FailureCategory, number>;
  byTimeWindow: Record<string, { count: number; percentage: number }>;
  transientRate: number; // proportion of transient vs permanent failures
  recoverabilityDistribution: Record<FailureCategory, number>; // count per category
}

// Evidence for a diagnosis
export interface DiagnosisEvidence {
  failureCodes: string[];
  categories: FailureCategory[];
  timeWindow: { start: number; end: number };
  affectedPaymentMethods: string[];
  affectedCustomerSegments: string[];
  historicalRecoveryRates: Record<FailureCategory, number>;
}

// Root cause diagnosis result
export interface Diagnosis {
  id: string;
  transactionId: string;
  primaryCategory: FailureCategory;
  primaryCategoryConfidence: number; // 0-1
  categories: FailureCategory[]; // all categories found, sorted by confidence
  evidence: DiagnosisEvidence;
  patterns: FailurePattern[];
  overallRecoverability: number; // 0-1, weighted by amounts and history
  calculatedAt: Date;
}

// Export all categories as array for iteration
export const ALL_FAILURE_CATEGORIES: FailureCategory[] = [
  FailureCategory.INSUFFICIENT_FUNDS,
  FailureCategory.BANK_FAILURE,
  FailureCategory.AUTH_FAILURE,
  FailureCategory.EXPIRED_INSTRUMENT,
  FailureCategory.NETWORK_TIMEOUT,
  FailureCategory.CUSTOMER_CANCELLATION,
  FailureCategory.UNKNOWN,
  FailureCategory.REPEATED_FAILURE,
  FailureCategory.PAYMENT_METHOD_DEGRADATION,
  FailureCategory.SUBSCRIPTION_FAILURE,
];

// Transient vs permanent classification
export const TRANSIENT_CATEGORIES: FailureCategory[] = [
  FailureCategory.NETWORK_TIMEOUT,
  FailureCategory.AUTH_FAILURE,
];

export const PERMANENT_CATEGORIES: FailureCategory[] = [
  FailureCategory.EXPIRED_INSTRUMENT,
  FailureCategory.CUSTOMER_CANCELLATION,
  FailureCategory.UNKNOWN,
];

export const CATEGORIES_WITH_RETRY: FailureCategory[] = [
  FailureCategory.INSUFFICIENT_FUNDS,
  FailureCategory.BANK_FAILURE,
  FailureCategory.NETWORK_TIMEOUT,
];

export const CATEGORIES_NO_RETRY: FailureCategory[] = [
  FailureCategory.EXPIRED_INSTRUMENT,
  FailureCategory.CUSTOMER_CANCELLATION,
];