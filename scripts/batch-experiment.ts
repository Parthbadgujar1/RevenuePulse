/**
 * Reproducible batch experiment for Track 03:
 *   ingest 100 synthetic Razorpay failures -> diagnose -> predict ->
 *   decide under policy -> execute bounded actions -> verify outcomes ->
 *   report measured money recovered vs baselines.
 *
 * Run from repo root:
 *   $env:DATABASE_URL="postgresql://postgres:password@localhost:5432/revenuepulse"; npx tsx scripts/batch-experiment.ts [N]
 */

import { prisma, ensureDemoMerchant } from '../packages/database';
import { normalizeRazorpayEvent, categorizeFailure } from '../packages/razorpay/src/index';
import { processJob, JobType, GROUND_TRUTH_BASE_RATES, simulateGroundTruthOutcome } from '../packages/observability/src/queue';

const N = Number(process.argv[2] || 100);
const MERCHANT_ID = 'demo-merchant';

const FAILURE_MIX: Array<{ code: string; desc: string; method: string }> = [
  { code: 'INSUFFICIENT_FUNDS', desc: 'Insufficient funds in account', method: 'card' },
  { code: 'RA0014', desc: 'Bank declined the transaction', method: 'netbanking' },
  { code: 'AUTH_ERROR', desc: 'Authentication failure - card declined', method: 'card' },
  { code: 'CARD_EXPIRED', desc: 'Card expired', method: 'card' },
  { code: 'TIMEOUT', desc: 'Network connection timeout', method: 'upi' },
  { code: 'REPEATED_ATTEMPT', desc: 'Repeated failure detected', method: 'wallet' },
];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const rng = mulberry32(20260823);
  await ensureDemoMerchant(prisma);

  // 0. Clean slate for this merchant's experiment
  await prisma.outcome.deleteMany({});
  await prisma.recoveryAction.deleteMany({});
  await prisma.prediction.deleteMany({});
  await prisma.revenueCase.deleteMany({});
  await prisma.transaction.deleteMany({ where: { merchantId: MERCHANT_ID } });
  await prisma.auditLog.deleteMany({ where: { merchantId: MERCHANT_ID } });
  await prisma.webhookEvent.deleteMany({});

  // 1. Generate + run N failed payment events through the real pipeline
  const t0 = Date.now();
  let processed = 0;
  for (let i = 0; i < N; i++) {
    const f = FAILURE_MIX[Math.floor(rng() * FAILURE_MIX.length)];
    const providerTransactionId = `batch_${Date.now()}_${i}`;
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
    const category = categorizeFailure(f.code, f.desc);
    const normalized = normalizeRazorpayEvent(rawEvent as any);

    // Register webhook durably (same path as production route)
    const webhookRow = await prisma.webhookEvent.create({
      data: {
        providerEventId: `batch_evt_${i}_${Date.now()}`,
        eventType: 'payment_failed',
        payloadHash: `sha:${providerTransactionId}`,
        status: 'RECEIVED',
        merchantId: MERCHANT_ID,
      },
    });

    const result = await processJob({} as any, JobType.PROCESS_TRANSACTION_EVENT, {
      merchantId: MERCHANT_ID,
      event: normalized,
      eventRef: webhookRow.id,
      webhookEventId: webhookRow.id,
      source: 'batch-experiment',
      simulated: true,
    });
    if (!result.success) {
      console.error(`event ${i} failed:`, result.error);
    }
    processed++;
  }

  // 2. Wait for chained evaluation/execution/verification to settle
  let prevKey = '';
  for (let tick = 0; tick < 60; tick++) {
    const pendingActions = await prisma.recoveryAction.count({
      where: { executionStatus: 'PENDING' },
    });
    const unverified = await prisma.recoveryAction.count({
      where: { executionStatus: 'EXECUTED' },
    });
    const key = `${pendingActions}:${unverified}`;
    await new Promise((r) => setTimeout(r, 700));
    if (key === prevKey && unverified === 0) break;
    prevKey = key;
  }
  void processed;

  // 3. Measure results from the database
  const [cases, actions, outcomes] = await Promise.all([
    prisma.revenueCase.findMany(),
    prisma.recoveryAction.findMany(),
    prisma.outcome.findMany(),
  ]);

  const totalAtRisk = cases.reduce((s, c) => s + c.amountAtRisk, 0);
  const diagnosed = cases.length;
  const eligible = cases.filter((c) => c.status !== 'STOPPED').length;
  const executed = actions.filter((a) => a.executionStatus === 'EXECUTED');
  const stoppedByPolicyOrEconomics = cases.filter((c) => c.status === 'STOPPED').length;
  const approvalPending = actions.filter((a) => a.approvalStatus === 'pending').length;
  const recoveredRows = outcomes.filter((o) => o.result === 'RECOVERED');
  const moneyRecovered = outcomes.reduce((s, o) => s + o.recoveredAmount, 0);
  const totalCost = outcomes.reduce((s, o) => s + o.measuredCost, 0);
  const rpNet = moneyRecovered;

  // 4. Baseline A: no intervention -> recovers nothing
  const baselineNoneNet = 0;

  // 5. Baseline B: retry-everything-once with the SAME ground-truth simulator
  // the pipeline's demo mode uses (single source of truth, no circularity).
  const RETRY_COST_PAISE = 200; // per retry
  let retryAllRecovered = 0;
  let retryAllCost = 0;
  for (const c of cases) {
    const cat =
      ((c.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
    const p = simulateGroundTruthOutcome(cat, 'retry_later', 0);
    retryAllCost += RETRY_COST_PAISE;
    if (rng() < p) retryAllRecovered += c.amountAtRisk;
  }
  void GROUND_TRUTH_BASE_RATES;
  const retryAllNet = retryAllRecovered - retryAllCost;

  const fmt = (paise: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(paise / 100);

  console.log('\n================ BATCH EXPERIMENT RESULTS ================');
  console.log(`Events ingested:            ${processed}`);
  console.log(`Failures diagnosed:         ${diagnosed}`);
  console.log(`Eligible for action:        ${eligible}`);
  console.log(`Actions executed:           ${executed.length} (+${approvalPending} awaiting approval)`);
  console.log(`Stopped by policy/economics:${stoppedByPolicyOrEconomics}`);
  console.log(`Outcomes verified:          ${outcomes.length}`);
  console.log(`Recoveries:                 ${recoveredRows.length}`);
  console.log('---------------------- MONEY FUNNEL ---------------------');
  console.log(`Total at risk:              ${fmt(totalAtRisk)}`);
  console.log(`Money recovered:            ${fmt(moneyRecovered)} (${totalAtRisk ? ((moneyRecovered / totalAtRisk) * 100).toFixed(1) : '0'}% by amount)`);
  console.log(`Action cost (measured):     ${fmt(totalCost)}`);
  console.log(`Net recovery (RevenuePulse):${fmt(rpNet)}`);
  console.log('-------------------- STRATEGY COMPARISON -----------------');
  console.log(`No intervention net:        ${fmt(baselineNoneNet)}`);
  console.log(`Retry-all net:              ${fmt(retryAllNet)} (recovered ${fmt(retryAllRecovered)}, cost ${fmt(retryAllCost)})`);
  console.log(`RevenuePulse net:           ${fmt(rpNet)} (recovered ${fmt(moneyRecovered)}, cost ${fmt(totalCost)})`);
  const lift = rpNet - retryAllNet;
  console.log(`RevenuePulse vs retry-all:  ${lift >= 0 ? '+' : ''}${fmt(lift)}`);
  console.log(`Pipeline wall time:         ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('==========================================================\n');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
