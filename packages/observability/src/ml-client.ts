/**
 * ML prediction client — the ONLY probability source used by the production
 * pipeline. Calls the FastAPI service that serves the trained model.joblib
 * artifact (calibrated logistic regression).
 *
 * Failure policy: strict by default — if the model cannot be reached the
 * pipeline job FAILS loudly instead of silently substituting a heuristic.
 * Set RP_ML_FALLBACK=heuristic to allow an explicitly-labeled fallback
 * (modelVersion 'heuristic-fallback-v1') for dev environments without Python.
 */
import type { RecoveryFeatures, BaselinePrediction } from '../../domain/src';
import { calculateRecoveryProbability } from '../../domain/src';

// NOTE: 127.0.0.1 explicitly — 'localhost' can resolve to ::1 first on
// Windows and hang until timeout when uvicorn binds IPv4 only.
const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8001';

export function toMlFeatures(features: RecoveryFeatures) {
  return {
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
  };
}

export class MlServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlServiceError';
  }
}

async function callPredict(features: RecoveryFeatures, caseId?: string) {
  const res = await fetch(`${ML_SERVICE_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features: toMlFeatures(features), case_id: caseId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MlServiceError(
      `ML service ${res.status} at ${ML_SERVICE_URL}/predict — ${detail.slice(0, 200)}`
    );
  }
  return res.json() as Promise<{
    probability: number;
    confidence: number;
    model_version: string;
    expected_recovery_value: number;
    feature_contributions: Record<string, number>;
  }>;
}

/**
 * Predict with the TRAINED calibrated model.
 * Throws (fails the job) when the service is unavailable unless
 * RP_ML_FALLBACK=heuristic is explicitly set — and even then the returned
 * BaselinePrediction carries a loud 'heuristic-fallback' model version so
 * nothing can silently pass a hand-coded score off as the real model.
 */
export async function predictRecoveryProbability(
  features: RecoveryFeatures,
  caseId?: string
): Promise<BaselinePrediction> {
  try {
    const r = await callPredict(features, caseId);
    return {
      modelVersion: r.model_version || 'model.joblib',
      recoveryProbability: Math.min(0.99, Math.max(0.01, r.probability)),
      expectedRecoveryValue: r.expected_recovery_value ?? Math.round(features.amount * r.probability),
      confidence: r.confidence ?? 0.5,
      featureWeights: {} as BaselinePrediction['featureWeights'], // real contributions live in featureSnapshot.featureContributions
      featureSnapshot: {
        ...features,
        featureContributions: r.feature_contributions ?? {},
      } as any,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (process.env.RP_ML_FALLBACK === 'heuristic') {
      const fallback = calculateRecoveryProbability(features);
      console.warn(
        `[ml-client] ML SERVICE UNAVAILABLE (${message}) — using LABELED heuristic fallback`
      );
      return {
        ...fallback,
        modelVersion: 'heuristic-fallback-v1',
        featureSnapshot: {
          ...features,
          mlUnavailableReason: message,
        } as any,
      };
    }
    throw new MlServiceError(
      `Recovery prediction failed: ${message}. ` +
        `Start the ML service (cd services/ml && uvicorn src.main:app --port 8001) ` +
        `or set RP_ML_FALLBACK=heuristic to allow a labeled fallback.`
    );
  }
}
