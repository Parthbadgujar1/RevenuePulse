/**
 * Prometheus-compatible application metrics (prom-client singleton).
 *
 * Exposed at /api/metrics in the web app. Safe against HMR double-init via
 * globalThis registration, same pattern as the Prisma client singleton.
 */
import client from 'prom-client';

const globalForMetrics = globalThis as unknown as {
  __revenuePulseMetrics?: typeof client;
};

function createRegistry(): typeof client {
  const existing = client.register;
  if (existing.getSingleMetric('rp_http_request_duration_seconds')) {
    return client;
  }

  client.collectDefaultMetrics({ prefix: 'rp_process_' });

  new client.Histogram({
    name: 'rp_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  });

  new client.Counter({
    name: 'rp_webhook_events_total',
    help: 'Webhook events processed by terminal status',
    labelNames: ['status', 'event_type'] as const,
  });

  new client.Counter({
    name: 'rp_recovery_actions_total',
    help: 'Recovery actions executed by intervention type',
    labelNames: ['intervention_type'] as const,
  });

  new client.Gauge({
    name: 'rp_queue_depth',
    help: 'Pending jobs per queue',
    labelNames: ['queue'] as const,
  });

  new client.Histogram({
    name: 'rp_ml_prediction_seconds',
    help: 'ML service prediction latency in seconds',
    labelNames: ['outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  new client.Counter({
    name: 'rp_ml_circuit_breaker_total',
    help: 'ML circuit breaker state transitions',
    labelNames: ['state'] as const,
  });

  new client.Gauge({
    name: 'rp_ml_drift_psi',
    help: 'Population Stability Index per feature (drift detection)',
    labelNames: ['feature'] as const,
  });

  new client.Gauge({
    name: 'rp_ml_training_rows',
    help: 'Total training data rows in production dataset',
    labelNames: ['source'] as const,
  });

  new client.Counter({
    name: 'rp_ml_retrain_total',
    help: 'Model retraining attempts',
    labelNames: ['status'] as const,
  });

  new client.Gauge({
    name: 'rp_ml_model_roc_auc',
    help: 'Current model ROC-AUC on held-out test set',
    labelNames: [] as const,
  });

  return client;
}

export const metrics: typeof client =
  globalForMetrics.__revenuePulseMetrics ?? createRegistry();

if (process.env.NODE_ENV !== 'production') {
  globalForMetrics.__revenuePulseMetrics = metrics;
}

/** Render all metrics in Prometheus text exposition format. */
export async function metricsToText(): Promise<string> {
  return metrics.register.metrics();
}

// Typed accessors - undefined-safe so call sites never crash if a metric
// was registered in a different bundle instance.
function getCounter(name: string): client.Counter<string> | undefined {
  return metrics.register.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
}

function getHistogram(name: string): client.Histogram<string> | undefined {
  return metrics.register.getSingleMetric(name) as
    | client.Histogram<string>
    | undefined;
}

export function incWebhookEvent(status: string, eventType: string): void {
  try {
    getCounter('rp_webhook_events_total')?.inc({ status, event_type: eventType });
  } catch {
    // metrics must never break the request path
  }
}

export function incRecoveryAction(interventionType: string): void {
  try {
    getCounter('rp_recovery_actions_total')?.inc({ intervention_type: interventionType });
  } catch {
    // metrics must never break the request path
  }
}

export function observeHttpDuration(
  route: string,
  method: string,
  status: number,
  seconds: number
): void {
  try {
    getHistogram('rp_http_request_duration_seconds')?.observe(
      { route, method, status: String(status) },
      seconds
    );
  } catch {
    // metrics must never break the request path
  }
}

export function observeMlPrediction(seconds: number, outcome: string): void {
  try {
    getHistogram('rp_ml_prediction_seconds')?.observe({ outcome }, seconds);
  } catch {
    // metrics must never break the request path
  }
}

export function incMlCircuitBreaker(state: string): void {
  try {
    getCounter('rp_ml_circuit_breaker_total')?.inc({ state });
  } catch {
    // metrics must never break the request path
  }
}

export function setQueueDepth(queue: string, depth: number): void {
  try {
    const g = metrics.register.getSingleMetric('rp_queue_depth') as
      | client.Gauge<string>
      | undefined;
    g?.set({ queue }, depth);
  } catch {
    // metrics must never break the request path
  }
}

export function setDriftPsi(feature: string, psi: number): void {
  try {
    const g = metrics.register.getSingleMetric('rp_ml_drift_psi') as
      | client.Gauge<string>
      | undefined;
    g?.set({ feature }, psi);
  } catch {
    // metrics must never break the request path
  }
}

export function setTrainingRows(source: string, count: number): void {
  try {
    const g = metrics.register.getSingleMetric('rp_ml_training_rows') as
      | client.Gauge<string>
      | undefined;
    g?.set({ source }, count);
  } catch {
    // metrics must never break the request path
  }
}

export function incRetrain(status: string): void {
  try {
    getCounter('rp_ml_retrain_total')?.inc({ status });
  } catch {
    // metrics must never break the request path
  }
}

export function setModelRocAuc(value: number): void {
  try {
    const g = metrics.register.getSingleMetric('rp_ml_model_roc_auc') as
      | client.Gauge<string>
      | undefined;
    g?.set(value);
  } catch {
    // metrics must never break the request path
  }
}
