/**
 * Structured logging for RevenuePulse.
 *
 * JSON output via pino, level controlled by LOG_LEVEL (default: info).
 * Every log call should carry a requestId so a single HTTP request or job
 * can be traced across web -> queue -> worker -> ML service.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  base: { service: 'revenuepulse' },
  redact: {
    paths: [
      'password',
      'passwordHash',
      'apiKey',
      'apiSecret',
      'keySecret',
      'webhookSecret',
      'secret',
      'authorization',
      'cookie',
      '*.password',
      '*.apiKey',
      '*.apiSecret',
      '*.keySecret',
      '*.webhookSecret',
    ],
    censor: '[redacted]',
  },
});

/** Generate a fresh correlation id (URL-safe, no dashes). */
export function newRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Child logger bound to one request/job lifecycle. */
export function requestLogger(requestId: string, extra?: Record<string, unknown>) {
  return logger.child({ requestId, ...extra });
}
