/**
 * Demo Lab batch runner - streams NDJSON progress events while running a
 * seeded cohort of synthetic failed payments through the REAL pipeline:
 * durable webhook rows -> diagnose -> ML predict -> policy decision ->
 * bounded execution -> outcome verification -> measured money results.
 *
 * Request body: { count?: number, failureCodes?: string[], seed?: number }
 * The seed makes the whole batch reproducible: same seed => same events,
 * same model scores, and the same seeded ground-truth outcome draws.
 * Re-running an identical (seed,count) is idempotent (dedup by event id).
 *
 * Response: application/x-ndjson, one JSON object per line:
 *   { type:'stage', key, label, total }
 *   { type:'progress', key, done }
 *   { type:'results', results }
 *   { type:'done' } | { type:'error', message }
 */
import { NextRequest } from 'next/server';
import { prisma } from '@rp/database';
import { normalizeRazorpayEvent, categorizeFailure } from '@rp/razorpay';
import {
  processJob,
  JobType,
  simulateGroundTruthOutcome,
} from '@rp/observability';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { csrfGuard } from '../../../../lib/csrf';

export const dynamic = 'force-dynamic';

const FAILURE_TYPES: Array<{ code: string; desc: string; method: string }> = [
  { code: 'INSUFFICIENT_FUNDS', desc: 'Insufficient funds in account', method: 'card' },
  { code: 'RA0014', desc: 'Bank declined the transaction', method: 'netbanking' },
  { code: 'AUTH_ERROR', desc: 'Authentication failure - card declined', method: 'card' },
  { code: 'CARD_EXPIRED', desc: 'Card expired', method: 'card' },
  { code: 'TIMEOUT', desc: 'Network connection timeout', method: 'upi' },
  { code: 'REPEATED_ATTEMPT', desc: 'Repeated failure detected', method: 'wallet' },
  { code: 'CUSTOMER_CANCELLED', desc: 'Customer cancelled the payment', method: 'card' },
];

const RETRY_COST_PAISE = 200;
export const DEFAULT_DEMO_SEED = 20260823;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const body = await req.json().catch(() => ({} as any));
  const count = Math.min(500, Math.max(5, Number(body?.count) || 100));
  const seed = Number(body?.seed) > 0 ? Math.floor(Number(body?.seed)) : DEFAULT_DEMO_SEED;
  const requested: string[] = Array.isArray(body?.failureCodes) && body.failureCodes.length
    ? body.failureCodes
    : FAILURE_TYPES.map((f) => f.code);
  const mix = FAILURE_TYPES.filter((f) => requested.includes(f.code));
  if (!mix.length) {
    return new Response(JSON.stringify({ error: 'No failure types selected' }), { status: 400 });
  }

  // Dataset identity: deterministic ids mean re-running the same seed/count
  // is a no-op (idempotent), and measurements stay scoped to this dataset
  // rather than to a wall-clock window.
  const datasetPrefix = `demo_s${seed}_`;
  const datasetLabel = `demo-batch-${seed}-${count}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        const rng = mulberry32(seed);
        const { merchantId } = await requireMerchantContext();

        // ---- Stage 1: generate + ingest through the real webhook pipeline ----
        send({ type: 'stage', key: 'ingest', label: 'Generating failed payment events…', total: count });
        let ingestedNew = 0;
        for (let i = 0; i < count; i++) {
          const f = mix[Math.floor(rng() * mix.length)];
          const providerTransactionId = `${datasetPrefix}${i}`;
          const amount = Math.floor(rng() * 990000) + 10000; // ₹100 – ₹10,000
          const rawEvent = {
            event: 'payment_failed',
            data: {
              id: providerTransactionId,
              amount,
              currency: 'INR',
              status: 'failed',
              method: f.method,
              error: { code: f.code, description: f.desc },
              time_created: new Date().toISOString(),
            },
          };
          void categorizeFailure(f.code, f.desc);
          const normalized = normalizeRazorpayEvent(rawEvent as any);

          const providerEventId = `demo:${seed}:${i}`;
          const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
          if (!existing) {
            const webhookRow = await prisma.webhookEvent.create({
              data: {
                providerEventId,
                eventType: 'payment_failed',
                payloadHash: `sha:${providerTransactionId}`,
                status: 'RECEIVED',
                merchantId,
              },
            });

            const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
              merchantId,
              event: normalized,
              eventRef: webhookRow.id,
              webhookEventId: webhookRow.id,
              source: 'demo-lab',
              simulated: true,
              groundTruthSeed: seed,
            });
            if (!result.success) {
              console.error(`demo-lab event ${i} failed:`, result.error);
            }
            ingestedNew++;
          }
          if ((i + 1) % 10 === 0 || i === count - 1) {
            send({ type: 'progress', key: 'ingest', done: i + 1 });
          }
        }

        // ---- Stage 2: wait for the AI pipeline to finish the cohort ----
        const datasetTxIds = (
          await prisma.transaction.findMany({
            where: { merchantId, providerTransactionId: { startsWith: datasetPrefix } },
            select: { id: true },
          })
        ).map((t) => t.id);
        const datasetCaseIds = (
          await prisma.revenueCase.findMany({
            where: { merchantId, transactionId: { in: datasetTxIds } },
            select: { id: true },
          })
        ).map((c) => c.id);

        send({ type: 'stage', key: 'pipeline', label: 'Running AI pipeline — diagnose → predict → decide → execute → verify…', total: count });
        let lastKey = '';
        let settled = false;
        const stageStart = Date.now();
        // Settle only when the cohort has shown zero in-flight work for a
        // full stability window (evaluations hit the ML service async, so
        // the first few hundred ms can legitimately look "empty").
        const STABILITY_MS = 2500;
        const MIN_WAIT_MS = 5000;
        let lastChangeAt = Date.now();
        if (ingestedNew > 0) {
          for (let tick = 0; tick < 180 && !settled; tick++) {
            const [openActions, unverified] = await Promise.all([
              prisma.recoveryAction.count({
                where: { executionStatus: 'PENDING', caseId: { in: datasetCaseIds } },
              }),
              prisma.recoveryAction.count({
                where: { executionStatus: 'EXECUTED', caseId: { in: datasetCaseIds }, outcome: null },
              }),
            ]);
            const done = Math.max(0, count - openActions - unverified);
            send({ type: 'progress', key: 'pipeline', done: Math.min(done, count) });
            const key = `${openActions}:${unverified}`;
            if (key !== lastKey) lastChangeAt = Date.now();
            const stableFor = Date.now() - lastChangeAt;
            if (
              key === lastKey &&
              openActions === 0 &&
              unverified === 0 &&
              stableFor >= STABILITY_MS &&
              Date.now() - stageStart >= MIN_WAIT_MS
            ) {
              settled = true;
              break;
            }
            lastKey = key;
            await sleep(500);
          }
        }
        send({ type: 'progress', key: 'pipeline', done: count });

        // ---- Stage 3: measure results from persisted data ----
        send({ type: 'stage', key: 'measure', label: 'Measuring recovered money…', total: 1 });
        const [cases, actions, outcomes] = await Promise.all([
          prisma.revenueCase.findMany({
            where: { id: { in: datasetCaseIds } },
            include: { transaction: { select: { providerTransactionId: true } } },
          }),
          prisma.recoveryAction.findMany({ where: { caseId: { in: datasetCaseIds } } }),
          prisma.outcome.findMany({ where: { action: { caseId: { in: datasetCaseIds } } } }),
        ]);

        const totalAtRisk = cases.reduce((s, c) => s + c.amountAtRisk, 0);
        const recoveredRows = outcomes.filter((o) => o.result === 'RECOVERED');
        const moneyRecovered = recoveredRows.reduce((s, o) => s + o.recoveredAmount, 0);
        const totalCost = outcomes.reduce((s, o) => s + o.measuredCost, 0);
        const executed = actions.filter((a) => a.executionStatus === 'EXECUTED');
        const approvedPending = actions.filter(
          (a) => a.approvalStatus === 'pending' && a.executionStatus !== 'EXECUTED'
        );
        const stopped = cases.filter((c) => c.status === 'STOPPED');

        // Fair comparison: retry-all is ALSO realized on this cohort using the
        // SAME seeded ground-truth simulator (deterministic per-payment roll,
        // keyed on the stable provider transaction id), not just an
        // expected-value shortcut.
        let retryAllRecovered = 0;
        let retryAllCost = 0;
        for (const c of cases) {
          const cat =
            ((c.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
          const p = simulateGroundTruthOutcome(cat, 'retry_later', c.attemptCount);
          const txId = (c as any).transaction?.providerTransactionId ?? c.id;
          const roll = mulberry32(fnv1a(`baseline:${txId}`) ^ seed)();
          retryAllCost += RETRY_COST_PAISE;
          if (roll < p) retryAllRecovered += c.amountAtRisk;
        }

        const results = {
          datasetLabel,
          seed,
          cohortSize: cases.length,
          funnel: {
            ingested: count,
            diagnosed: cases.length,
            eligible: cases.length - stopped.length,
            actionsDecided: actions.length,
            executed: executed.length,
            awaitingApproval: approvedPending.length,
            stoppedByPolicyOrEconomics: stopped.length,
            verified: outcomes.length,
            recovered: recoveredRows.length,
          },
          money: {
            atRisk: totalAtRisk,
            recovered: moneyRecovered,
            cost: totalCost,
            net: moneyRecovered - totalCost,
            recoveryRatePct: totalAtRisk > 0 ? (moneyRecovered / totalAtRisk) * 100 : 0,
          },
          strategies: {
            noIntervention: { recovered: 0, cost: 0, net: 0 },
            retryAll: {
              recovered: retryAllRecovered,
              cost: retryAllCost,
              net: retryAllRecovered - retryAllCost,
              note: 'simulated (seeded)',
            },
            revenuePulse: {
              recovered: moneyRecovered,
              cost: totalCost,
              net: moneyRecovered - totalCost,
            },
            upliftVsRetryAll: moneyRecovered - totalCost - (retryAllRecovered - retryAllCost),
          },
        };

        send({ type: 'stage_done', key: 'measure', label: 'Done' });
        send({ type: 'results', results });
        send({ type: 'done' });
        controller.close();
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
