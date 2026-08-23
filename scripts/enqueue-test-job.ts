/**
 * Enqueue a PROCESS_TRANSACTION_EVENT job through the real pg-boss queue
 * to demonstrate worker consumption end-to-end.
 *
 * Run from repo root:
 *   $env:DATABASE_URL="..."; npx tsx scripts/enqueue-test-job.ts
 */
import { PgBoss } from 'pg-boss';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:password@localhost:5432/revenuepulse?schema=public';

async function main() {
  const boss = new PgBoss({
    connectionString: DATABASE_URL,
    schema: 'pgboss',
  });
  await boss.start();

  const jobId = await boss.send('rp-process-transaction-event', {
    type: 'process-transaction-event',
    payload: {
      event: {
        eventType: 'payment_failed',
        safeMetadata: {
          providerTransactionId: 'worker_test_' + Date.now(),
          amount: 123456,
          currency: 'INR',
          status: 'failed',
          paymentMethod: 'card',
          failureCode: 'TIMEOUT',
          failureMessage: 'Network connection timeout',
          failureCategory: 'network_timeout',
          occurredAt: new Date().toISOString(),
        },
      },
      eventRef: 'event_ref_worker_smoke',
      source: 'worker-smoke-test',
      simulated: true,
    },
    source: 'smoke-script',
  });

  console.log('enqueued job id:', jobId);
  await new Promise((r) => setTimeout(r, 3000));
  await boss.stop();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
