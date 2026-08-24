/**
 * Demo Lab batch runner - streams NDJSON progress events while running a
 * seeded cohort of synthetic failed payments through the REAL pipeline:
 * durable webhook rows -> diagnose -> ML predict -> policy decision ->
 * bounded execution -> outcome verification -> measured money results.
 *
 * Request body: { count?: number, failureCodes?: string[] }
 * Response: application/x-ndjson, one JSON object per line:
 *   { type:'stage', key, label, total }
 *   { type:'progress', key, done }
 *   { type:'results', results }
 *   { type:'done' } | { type:'error', message }
 */
import { NextRequest } from 'next/server';
import { prisma, ensureDemoMerchant } from '@rp/database';
import { normalizeRazorpayEvent, categorizeFailure } from '@rp/razorpay';
import {
  processJob,
  JobType,
  simulateGroundTruthOutcome,
} from '@rp/observability';

export const dynamic = 'force-dynamic';

const FAILURE_TYPES: Array<{ code: string; desc: string; method: string }> = [
  { code: 'INSUFFICIENT_FUNDS', desc: 'Insufficient funds in account', method: 'card' },
  { code: 'RA0014', desc: 'Bank declined the transaction', method: 'netbanking' },
  { code: 'AUTH_ERROR', desc: 'Authentication failure - card declined', method: 'card' },
  { code: 'CARD_EXPIRED', desc: 'Card expired', method: 'card' },
  { code: 'TIMEOUT', desc: 'Network connection timeout', method: 'upi' },
  { code: 'REPEATED_ATTEMPT', desc: 'Repeated failure detected', method: 'wallet' },
];

const RETRY_COST_PAISE = 200;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const count = Math.min(500, Math.max(5, Number(body?.count) || 100));
  const requested: string[] = Array.isArray(body?.failureCodes) && body.failureCodes.length
    ? body.failureCodes
    : FAILURE_TYPES.map((f) => f.code);
  const mix = FAILURE_TYPES.filter((f) => requested.includes(f.code));
  if (!mix.length) {
    return new Response(JSON.stringify({ error: 'No failure types selected' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        const rng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0);
        const merchantId = await ensureDemoMerchant(prisma);
        const cohortStart = new Date();

        // ---- Stage 1: generate + ingest through the real webhook pipeline ----
        send({ type: 'stage', key: 'ingest', label: 'Generating failed payment events…', total: count });
        for (let i = 0; i < count; i++) {
          const f = mix[Math.floor(rng() * mix.length)];
          const providerTransactionId = `demo_${Date.now()}_${i}_${Math.floor(rng() * 1e6)}`;
          const rawEvent = {
            event: 'payment_failed',
            data: {
              id: providerTransactionId,
              amount: Math.floor(rng() * 990000) + 10000, // ₹100 – ₹10,000
              currency: 'INR',
              status: 'failed',
              method: f.method,
              error: { code: f.code, description: f.desc },
              time_created: new Date().toISOString(),
            },
          };
          void categorizeFailure(f.code, f.desc);
          const normalized = normalizeRazorpayEvent(rawEvent as any);

          const webhookRow = await prisma.webhookEvent.create({
            data: {
              providerEventId: `demo_evt_${i}_${Date.now()}_${Math.floor(rng() * 1e6)}`,
              eventType: 'payment_failed',
              payloadHash: `sha:${providerTransactionId}`,
              status: 'RECEIVED',
              merchantId,
            },
          });

          const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
            event: normalized,
            eventRef: webhookRow.id,
            webhookEventId: webhookRow.id,
            source: 'demo-lab',
            simulated: true,
          });
          if (!result.success) {
            console.error(`demo-lab event ${i} failed:`, result.error);
          }
          if ((i + 1) % 10 === 0 || i === count - 1) {
            send({ type: 'progress', key: 'ingest', done: i + 1 });
          }
        }

        // ---- Stage 2: wait for the AI pipeline to finish the cohort ----
        send({ type: 'stage', key: 'pipeline', label: 'Running AI pipeline — diagnose → predict → decide → execute → verify…', total: count });
        let lastKey = '';
        let settled = false;
        for (let tick = 0; tick < 180 && !settled; tick++) {
          const [openActions, unverified] = await Promise.all([
            prisma.recoveryAction.count({ where: { executionStatus: 'PENDING', createdAt: { gte: cohortStart } } }),
            prisma.recoveryAction.count({ where: { executionStatus: 'EXECUTED', createdAt: { gte: cohortStart }, outcome: null } }),
          ]);
          const done = Math.max(0, count - openActions - unverified);
          send({ type: 'progress', key: 'pipeline', done: Math.min(done, count) });
          const key = `${openActions}:${unverified}`;
          if (key === lastKey && openActions === 0 && unverified === 0) {
            settled = true;
            break;
          }
          lastKey = key;
          await sleep(700);
        }
        send({ type: 'progress', key: 'pipeline', done: count });

        // ---- Stage 3: measure results from persisted data ----
        send({ type: 'stage', key: 'measure', label: 'Measuring recovered money…', total: 1 });
        const window_ = { gte: cohortStart };
        const [cases, actions, outcomes] = await Promise.all([
          prisma.revenueCase.findMany({ where: { createdAt: window_ } }),
          prisma.recoveryAction.findMany({ where: { createdAt: window_ } }),
          prisma.outcome.findMany({ where: { createdAt: window_ } }),
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

        // Baselines on the SAME cohort using the SAME ground-truth simulator.
        // Shown as deterministic EXPECTED values so the comparison is stable;
        // RevenuePulse numbers are the realized outcome draws.
        let retryAllExpectedRecovered = 0;
        let retryAllCost = 0;
        for (const c of cases) {
          const cat =
            ((c.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
          const p = simulateGroundTruthOutcome(cat, 'retry_later', 0);
          retryAllCost += RETRY_COST_PAISE;
          retryAllExpectedRecovered += Math.round(p * c.amountAtRisk);
        }

        const results = {
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
              recovered: retryAllExpectedRecovered,
              cost: retryAllCost,
              net: retryAllExpectedRecovered - retryAllCost,
              note: 'expected value',
            },
            revenuePulse: {
              recovered: moneyRecovered,
              cost: totalCost,
              net: moneyRecovered - totalCost,
            },
            upliftVsRetryAll:
              moneyRecovered - totalCost - (retryAllExpectedRecovered - retryAllCost),
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
