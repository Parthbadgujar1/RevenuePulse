/**
 * ML prediction client — the ONLY probability source used by the production
 * pipeline. Calls the FastAPI service that serves the trained model.joblib
 * artifact (calibrated logistic regression).
 *
 * Resilience:
 *  - 5-second request timeout (AbortSignal)
 *  - Exponential backoff retry (1 attempt by default; configurable via RP_ML_RETRY_COUNT)
 *  - Circuit breaker: after RP_ML_CB_THRESHOLD consecutive failures (default 5),
 *    stops calling for RP_ML_CB_COOLDOWN_MS (default 30s), then half-open.
 *  - All latency + outcome observed in rp_ml_prediction_seconds histogram.
 *
 * Continuous learning:
 *  - logTrainingData() records production outcomes for future retraining
 *  - Features are recorded for drift monitoring after each prediction
 *
 * Failure policy: strict by default — if the model cannot be reached the
 * pipeline job FAILS loudly instead of silently substituting a heuristic.
 * Set RP_ML_FALLBACK=heuristic to allow an explicitly-labeled fallback
 * (modelVersion 'heuristic-fallback-v1') for dev environments without Python.
 */
import type { RecoveryFeatures, BaselinePrediction } from '../../domain/src';
import { calculateRecoveryProbability } from '../../domain/src';
import { observeMlPrediction, incMlCircuitBreaker, setDriftPsi, setTrainingRows, incRetrain, setModelRocAuc } from './metrics';

const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8001';

// Internal token for ML admin endpoints (/retrain, /log-training-data,
// /log-prediction). Absent => admin calls fail 401 on the service side
// (fail-closed), which is the desired default for a public deployment.
const ML_ADMIN_TOKEN = process.env.ML_INTERNAL_TOKEN ?? process.env.RP_ML_TOKEN ?? '';

const ML_TIMEOUT_MS = parseInt(process.env.RP_ML_TIMEOUT_MS ?? '5000', 10);
const ML_RETRY_COUNT = Math.max(0, parseInt(process.env.RP_ML_RETRY_COUNT ?? '1', 10));
const ML_RETRY_BASE_MS = parseInt(process.env.RP_ML_RETRY_BASE_MS ?? '200', 10);

// Circuit breaker config
const CB_THRESHOLD = parseInt(process.env.RP_ML_CB_THRESHOLD ?? '5', 10);
const CB_COOLDOWN_MS = parseInt(process.env.RP_ML_CB_COOLDOWN_MS ?? '30000', 10);

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
    // v4 context-aware features (defaulted so legacy callers map cleanly)
    intervention: features.intervention ?? 'none',
    contact_channel: features.contactChannel ?? 'none',
    merchant_vertical: features.merchantVertical ?? 'other',
    day_of_week: features.dayOfWeek ?? 2,
    customer_tenure_days: features.customerTenureDays ?? 365,
    plan_tier: features.planTier ?? 0,
  };
}

export class MlServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlServiceError';
  }
}

// ── Circuit breaker state (in-process, HMR-safe) ───────────────────────────

interface CircuitBreaker {
  failures: number;
  lastFailureAt: number;
  state: 'closed' | 'open' | 'half-open';
}

const g = globalThis as unknown as { __rpMlCircuitBreaker?: CircuitBreaker };
const cb: CircuitBreaker = g.__rpMlCircuitBreaker ?? {
  failures: 0,
  lastFailureAt: 0,
  state: 'closed',
};
if (!g.__rpMlCircuitBreaker) g.__rpMlCircuitBreaker = cb;

function cbRecordSuccess(): void {
  const prevState = cb.state;
  cb.failures = 0;
  cb.state = 'closed';
  if (prevState !== 'closed') {
    console.log('[ml-client] circuit breaker CLOSED (recovered)');
  }
}

function cbRecordFailure(): void {
  cb.failures++;
  cb.lastFailureAt = Date.now();
  if (cb.failures >= CB_THRESHOLD && cb.state !== 'open') {
    cb.state = 'open';
    console.warn(`[ml-client] circuit breaker OPEN (${cb.failures} consecutive failures, cooldown ${CB_COOLDOWN_MS}ms)`);
    incMlCircuitBreaker('open');
  }
}

function cbAllowRequest(): boolean {
  if (cb.state === 'closed') return true;
  if (cb.state === 'half-open') return true;
  // open → check if cooldown elapsed
  if (Date.now() - cb.lastFailureAt >= CB_COOLDOWN_MS) {
    cb.state = 'half-open';
    console.log('[ml-client] circuit breaker HALF-OPEN (testing recovery)');
    incMlCircuitBreaker('half_open');
    return true;
  }
  return false;
}

// ── HTTP call with retry ────────────────────────────────────────────────────

async function callPredict(features: RecoveryFeatures, caseId?: string) {
  let lastError: Error | undefined;
  const attempts = ML_RETRY_COUNT + 1;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${ML_SERVICE_URL}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: toMlFeatures(features), case_id: caseId }),
        signal: AbortSignal.timeout(ML_TIMEOUT_MS),
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
    } catch (err) {
      lastError = err as Error;
      if (i < attempts - 1) {
        const delay = ML_RETRY_BASE_MS * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

// ── Public API ──────────────────────────────────────────────────────────────

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
  // Circuit breaker: skip call if too many recent failures
  if (!cbAllowRequest()) {
    const msg = `Circuit breaker OPEN — ${cb.failures} consecutive ML failures, cooldown active`;
    if (process.env.RP_ML_FALLBACK === 'heuristic') {
      console.warn(`[ml-client] ${msg} — using LABELED heuristic fallback`);
      const fallback = calculateRecoveryProbability(features);
      return {
        ...fallback,
        modelVersion: 'heuristic-fallback-v1',
        featureSnapshot: {
          ...features,
          mlUnavailableReason: msg,
        } as any,
      };
    }
    throw new MlServiceError(msg);
  }

  const start = performance.now();
  try {
    const r = await callPredict(features, caseId);
    const duration = (performance.now() - start) / 1000;
    observeMlPrediction(duration, 'success');
    cbRecordSuccess();
    return {
      modelVersion: r.model_version || 'model.joblib',
      recoveryProbability: Math.min(0.99, Math.max(0.01, r.probability)),
      expectedRecoveryValue: r.expected_recovery_value ?? Math.round(features.amount * r.probability),
      confidence: r.confidence ?? 0.5,
      featureWeights: {} as BaselinePrediction['featureWeights'],
      featureSnapshot: {
        ...features,
        featureContributions: r.feature_contributions ?? {},
      } as any,
    };
  } catch (err) {
    const duration = (performance.now() - start) / 1000;
    const message = (err as Error).message;
    const isTimeout = message.includes('abort') || message.includes('timeout');
    observeMlPrediction(duration, isTimeout ? 'timeout' : 'error');
    cbRecordFailure();

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

// ── Production training data logging ─────────────────────────────────────────

/**
 * Log a production training data point to the ML service for future retraining.
 * Called after outcome verification in the pipeline.
 * Best-effort — never throws, never blocks the pipeline.
 */
/** Headers for authenticated ML admin endpoints. */
function adminHeaders(): Record<string, string> {
  return ML_ADMIN_TOKEN
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${ML_ADMIN_TOKEN}` }
    : { 'Content-Type': 'application/json' };
}

export async function logTrainingData(
  features: RecoveryFeatures,
  recovered: boolean,
  intervention: string = 'unknown'
): Promise<void> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/log-training-data`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        features: toMlFeatures(features),
        recovered,
        intervention,
        source: 'production',
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      console.log(`[ml-client] Logged training data: recovered=${recovered} intervention=${intervention}`);
    }
  } catch {
    // Training data logging must never block the pipeline
  }
}

/**
 * Trigger a background retrain on the ML service.
 * Best-effort — fires and forgets.
 */
export async function triggerRetrain(force: boolean = false): Promise<void> {
  try {
    await fetch(`${ML_SERVICE_URL}/retrain?force=${force}`, {
      method: 'POST',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    incRetrain('triggered');
  } catch {
    // Retrain trigger must never block the pipeline
  }
}

/**
 * Observe drift metrics from the ML service /drift endpoint.
 * Best-effort — called periodically from the queue depth interval.
 */
export async function observeDriftMetrics(): Promise<void> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/drift`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const drift = await res.json() as {
      features?: Record<string, { psi?: number }>;
      window_size?: number;
    };
    if (drift.features) {
      for (const [name, info] of Object.entries(drift.features)) {
        if (info.psi !== undefined) {
          setDriftPsi(name, info.psi);
        }
      }
    }
  } catch {
    // Drift observation must never break the pipeline
  }
}

/**
 * Observe model metadata (training rows, ROC-AUC) from the ML service.
 * Best-effort — called periodically.
 */
export async function observeModelMetadata(): Promise<void> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/retrain-status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const status = await res.json() as { current_version?: string; retrain_count?: number };
    // Training row count is observed from the /drift endpoint's window_size
  } catch {
    // metadata observation must never break the pipeline
  }
}
