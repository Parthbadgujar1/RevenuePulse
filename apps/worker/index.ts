/**
 * RevenuePulse background worker
 *
 * Consumes recovery-pipeline jobs from PostgreSQL via pg-boss.
 * Queue naming: rp-<job-type> (one queue per JobType).
 *
 * Run from repo root:
 *   $env:DATABASE_URL="..."; npx tsx apps/worker/index.ts
 */

import { PgBoss } from 'pg-boss';
import { processJob, JobType } from '../../packages/observability/src/queue';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:password@localhost:5432/revenuepulse?schema=public';

const QUEUE_PREFIX = 'rp-';

async function main(): Promise<void> {
  const boss = new PgBoss({
    connectionString: DATABASE_URL,
    // Keep schema isolated from application tables
    schema: 'pgboss',
  });

  boss.on('error', (err: Error) => {
    console.error('[worker] pg-boss error:', err.message);
  });

  await boss.start();
  console.log('[worker] pg-boss started');

  for (const jobType of Object.values(JobType)) {
    const queue = `${QUEUE_PREFIX}${jobType}`;
    await boss.createQueue(queue);
    // pg-boss v12 delivers jobs to the handler as a batch array
    await boss.work(queue, async (batch: any[]) => {
      for (const job of batch) {
        const payload = job?.data?.payload ?? job?.data ?? {};
        console.log(`[worker] ${queue} <- job ${job?.id ?? '?'}`);
        try {
          const result = await processJob(boss as never, jobType, payload);
          if (!result.success) {
            throw new Error(result.error || 'job failed');
          }
        } catch (err) {
          console.error(`[worker] job ${job?.id ?? '?'} failed:`, (err as Error).message);
          throw err; // let pg-boss retry per its policy
        }
      }
    });
    console.log(`[worker] listening on ${queue}`);
  }

  console.log('[worker] ready - waiting for jobs');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, stopping...`);
    try {
      await boss.stop();
      console.log('[worker] stopped cleanly');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
