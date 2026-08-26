// Retry Sequencer
// Pure business logic for scheduling payment retries with backoff strategies

export interface RetryWindow {
  /** Base delay in hours before first retry */
  baseHours: number;
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Backoff strategy */
  backoff: 'exponential' | 'linear' | 'fixed';
  /** Random jitter added to delay in milliseconds */
  jitterMs: number;
}

export interface RetrySchedule {
  /** Absolute retry time as ISO string */
  retryAt: string;
  /** Retry attempt number (1-based) */
  attempt: number;
  /** Delay in hours for this attempt */
  delayHours: number;
}

// Failure-category-specific retry windows
export const RETRY_WINDOWS: Record<string, RetryWindow | null> = {
  network_timeout: {
    baseHours: 24,
    maxRetries: 5,
    backoff: 'exponential',
    jitterMs: 3600000,
  },
  insufficient_funds: {
    baseHours: 72,
    maxRetries: 3,
    backoff: 'exponential',
    jitterMs: 7200000,
  },
  bank_failure: {
    baseHours: 48,
    maxRetries: 4,
    backoff: 'exponential',
    jitterMs: 3600000,
  },
  auth_failure: {
    baseHours: 24,
    maxRetries: 2,
    backoff: 'fixed',
    jitterMs: 1800000,
  },
  expired_instrument: null,
  customer_cancellation: null,
};

// Deterministic jitter based on attempt and session
function calculateJitter(jitterMs: number, attempt: number): number {
  // Simple deterministic jitter: rotate through a small range
  const seed = attempt * 7919; // prime multiplier
  return (seed % jitterMs);
}

// Calculate delay in hours for a given retry attempt
function calculateDelayHours(window: RetryWindow, currentRetry: number): number {
  switch (window.backoff) {
    case 'fixed':
      return window.baseHours;

    case 'linear':
      return window.baseHours * (currentRetry + 1);

    case 'exponential':
      return window.baseHours * Math.pow(2, currentRetry);
  }
}

// Calculate the next retry time
export function calculateNextRetryTime(
  window: RetryWindow,
  currentRetry: number
): RetrySchedule {
  const delayHours = calculateDelayHours(window, currentRetry);
  const jitterHours = calculateJitter(window.jitterMs, currentRetry) / 3600000;
  const totalDelay = delayHours + jitterHours;

  const retryAt = new Date();
  retryAt.setHours(retryAt.getHours() + totalDelay);

  return {
    retryAt: retryAt.toISOString(),
    attempt: currentRetry + 1,
    delayHours: Math.round(totalDelay * 100) / 100,
  };
}

// Determine whether to retry given the window, current attempt, and customer health
export function shouldRetry(
  window: RetryWindow | null,
  currentRetry: number,
  customerHealthScore: number
): { retry: boolean; reason: string } {
  if (!window) {
    return { retry: false, reason: 'No retry configured for this failure category.' };
  }

  if (currentRetry >= window.maxRetries) {
    return {
      retry: false,
      reason: `Maximum retries (${window.maxRetries}) exhausted.`,
    };
  }

  if (customerHealthScore <= 10) {
    return {
      retry: false,
      reason: 'Customer health score critically low; stop retrying to avoid churn.',
    };
  }

  if (customerHealthScore <= 30 && currentRetry >= 2) {
    return {
      retry: false,
      reason: 'Customer health low and multiple retries already attempted.',
    };
  }

  return {
    retry: true,
    reason: `Retry permitted: attempt ${currentRetry + 1}/${window.maxRetries}, health=${customerHealthScore}.`,
  };
}
