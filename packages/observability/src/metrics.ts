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
