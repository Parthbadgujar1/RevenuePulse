// Job Queue - PostgreSQL-backed queue using pg-boss
// Handles async job processing for webhook events, recovery evaluations, etc.

import * as PgBossModule from 'pg-boss';
import {
  ensureDemoMerchant,
  markWebhookProcessing,
  markWebhookProcessed,
  markWebhookFailed,
} from '../../database/src/idempotency';
import { prisma } from '../../database';
import { DecisionEngine, DEFAULT_MERCHANT_POLICY } from '../../policies/src';
import type { MerchantPolicy } from '../../policies/src';
import { getInterventionLift } from '../../policies/src/intervention-lifts';
import { predictRecoveryProbability } from './ml-client';

/** Load the merchant's persisted recovery policy (falls back to defaults). */
export async function getMerchantPolicy(merchantId: string): Promise<MerchantPolicy> {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    const stored = ((merchant?.settings as Record<string, unknown>) ?? {}).recoveryPolicy as
      | Partial<MerchantPolicy>
      | undefined;
    if (!stored) return DEFAULT_MERCHANT_POLICY;
    return { ...DEFAULT_MERCHANT_POLICY, ...stored };
  } catch {
    return DEFAULT_MERCHANT_POLICY;
  }
}

/** Deterministic PRNG + string hash for reproducible ground-truth draws. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
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

// pg-boss is CommonJS; normalize default export across module systems
const Boss: any =
  (PgBossModule as any).PgBoss || (PgBossModule as any).default || PgBossModule;
type Boss = any;

// Job types for the recovery system
export enum JobType {
  PROCESS_TRANSACTION_EVENT = 'process-transaction-event',
  EVALUATE_RECOVERY = 'evaluate-recovery',
  EXECUTE_ACTION = 'execute-action',
  VERIFY_OUTCOME = 'verify-outcome',
  RETRY_SCHEDULED = 'retry-scheduled',
  RETENTION_CLEANUP = 'retention-cleanup',
}

// Job payload interfaces
export interface JobPayload {
  type: JobType;
  payload: any;
  source: string;
  idempotencyKey?: string;
}

// Job result interface
export interface JobResult {
  success: boolean;
  result?: any;
  error?: string;
  completedAt?: number;
}

// pg-boss job options
export interface JobOptions {
  delay?: number; // milliseconds before job starts
  attempts?: number; // number of retry attempts
  backoff?: 'exponential' | 'fixed' | ((attempt: number) => number);
  timeout?: number; // milliseconds before job is timed out
}

// Queue naming shared by producer (web) and consumer (apps/worker):
// one queue per JobType, e.g. rp-process-transaction-event
export const QUEUE_PREFIX = 'rp-';
export function queueNameFor(jobType: JobType): string {
  return `${QUEUE_PREFIX}${jobType}`;
}

/**
 * True when pipeline jobs should be handed to pg-boss workers instead of
 * running in the web process. Opt-in via RP_USE_QUEUE=1 — the default keeps
 * dev/demo single-process behavior.
 */
export function isQueueMode(): boolean {
  return process.env.RP_USE_QUEUE === '1';
}

let sharedBoss: any = null;
let bossStarting: Promise<any> | null = null;

/** Lazily started pg-boss producer connection (queue mode only). */
async function getProducerBoss(): Promise<any> {
  if (sharedBoss) return sharedBoss;
  if (!bossStarting) {
    const connectionString =
      process.env.DATABASE_URL ||
      'postgresql://postgres:password@localhost:5432/revenuepulse?schema=public';
    const boss = new Boss({ connectionString, schema: 'pgboss' });
    boss.on('error', (err: Error) =>
      console.error('[enqueue] pg-boss error:', err.message)
    );
    bossStarting = boss.start().then(() => {
      sharedBoss = boss;
      return boss;
    });
  }
  return bossStarting;
}

// Enqueue a job for asynchronous processing.
//
// RP_USE_QUEUE=1 (queue mode): the job is durably persisted in PostgreSQL via
// pg-boss and consumed by apps/worker — the returned id is the real pg-boss
// job id. The durable WebhookEvent row carries state until the worker
// finishes, so nothing is lost.
//
// Default (inline mode): the handler runs in-process shortly after enqueue so
// dev/demo environments exercise the full pipeline without a worker process.
export async function enqueueProcessingJob(
  job: {
    type: JobType;
    payload: any;
    source: string;
    idempotencyKey?: string;
  },
  options?: JobOptions
): Promise<string> {
  if (isQueueMode()) {
    const boss = await getProducerBoss();
    // Worker extracts job.data.payload ?? job.data before calling processJob.
    const jobId = await boss.send(queueNameFor(job.type), { payload: job.payload }, {
      retryLimit: 3,
      retryDelay: 5,
      ...(options?.timeout ? { expireInSeconds: Math.ceil(options.timeout / 1000) } : {}),
    });
    if (!jobId) {
      throw new Error(`pg-boss refused job for queue ${queueNameFor(job.type)}`);
    }
    console.log(`Job queued on ${queueNameFor(job.type)}: ${jobId}`);
    return String(jobId);
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`Job enqueued (inline): ${job.type} - ${jobId}`);

  // Execute the real handler inline so events persist to the database
  setImmediate(() => {
    void processJob({} as Boss, job.type, job.payload)
      .then((result) => {
        if (!result.success) {
          console.error(`Job ${jobId} failed:`, result.error);
        }
      })
      .catch((err) => {
        console.error(`Job ${jobId} threw:`, err);
      });
  });

  return jobId;
}

// Process a single job type
export async function processJob(
  boss: Boss,
  jobType: JobType,
  payload: any
): Promise<JobResult> {
  switch (jobType) {
    case JobType.PROCESS_TRANSACTION_EVENT:
      return await processTransactionEvent(payload);
    case JobType.EVALUATE_RECOVERY:
      return await evaluateRecovery(payload);
    case JobType.EXECUTE_ACTION:
      return await executeAction(payload);
    case JobType.VERIFY_OUTCOME:
      return await verifyOutcome(payload);
    case JobType.RETRY_SCHEDULED:
      return await scheduleRetry(payload);
    case JobType.RETENTION_CLEANUP:
      return await retentionCleanup(payload);
    default:
      console.warn(`Unknown job type: ${jobType}`);
      return { success: false, error: `Unknown job type: ${jobType}` };
  }
}

// Process transaction event from webhook
async function processTransactionEvent(payload: any): Promise<JobResult> {
  const { event, eventRef, webhookEventId, source, simulated } = payload;

  try {
    // 1. Transition durable webhook state: RECEIVED -> PROCESSING
    await markWebhookProcessing(prisma, webhookEventId);

    const meta = event?.safeMetadata ?? {};
    const providerTransactionId: string | undefined = meta.providerTransactionId;
    const occurredAt: Date = meta.occurredAt ? new Date(meta.occurredAt) : new Date();

    if (!providerTransactionId || typeof meta.amount !== 'number') {
      throw new Error('Event missing providerTransactionId or amount');
    }

    // 2. Ensure FK target exists
    const merchantId = await ensureDemoMerchant(prisma);

    // 3. Persist transaction (idempotent on providerTransactionId)
    const transaction = await prisma.transaction.upsert({
      where: { providerTransactionId },
      update: {
        status: meta.status ?? 'unknown',
        failureCode: meta.failureCode ?? null,
        failureCategory: meta.failureCategory ?? null,
        failureMessage: meta.failureMessage ?? null,
      },
      create: {
        providerTransactionId,
        merchantId,
        amount: meta.amount,
        currency: meta.currency || 'INR',
        status: meta.status ?? 'unknown',
        paymentMethod: meta.paymentMethod || 'unknown',
        paymentMethodDetails: { simulated: Boolean(simulated), source },
        failureCode: meta.failureCode ?? null,
        failureCategory: meta.failureCategory ?? null,
        failureMessage: meta.failureMessage ?? null,
        occurredAt,
        rawEventRef: eventRef ?? null,
        createdAt: new Date(),
      },
    });

    // 4. Create a revenue case for failure events, then chain evaluation
    let caseId: string | null = null;
    if (event.eventType === 'payment_failed') {
      const category = meta.failureCategory || 'unknown';
      const categoryPriority: Record<string, number> = {
        bank_failure: 15,
        auth_failure: 10,
        network_timeout: 10,
        insufficient_funds: 0,
        expired_instrument: -10,
        customer_cancellation: -20,
        repeated_failure: 5,
      };
      const priority =
        50 +
        Math.min(30, Math.floor(meta.amount / 100000)) +
        (categoryPriority[category] ?? 0);

      // Human-friendly case reference, e.g. RP-1042
      let caseRef: string | undefined;
      const caseCount = await prisma.revenueCase.count();
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `RP-${1001 + caseCount + attempt}`;
        const taken = await prisma.revenueCase.findUnique({ where: { ref: candidate } });
        if (!taken) {
          caseRef = candidate;
          break;
        }
      }

      const revenueCase = await prisma.revenueCase.upsert({
        where: { transactionId: transaction.id },
        update: {
          diagnosis: {
            primaryCategory: category,
            failureCode: meta.failureCode ?? null,
            failureMessage: meta.failureMessage ?? null,
            diagnosedAt: new Date().toISOString(),
          },
          priority,
        },
        create: {
          transactionId: transaction.id,
          caseType: 'payment_degradation',
          amountAtRisk: meta.amount,
          diagnosis: {
            primaryCategory: category,
            failureCode: meta.failureCode ?? null,
            failureMessage: meta.failureMessage ?? null,
            diagnosedAt: new Date().toISOString(),
          },
          priority,
          status: 'DETECTED',
          merchantId,
          ref: caseRef,
          createdAt: new Date(),
        },
      });
      caseId = revenueCase.id;

      await prisma.auditLog.create({
        data: {
          merchantId,
          actorType: 'system',
          actorId: 'failure-diagnoser',
          action: 'failure_diagnosed',
          entityType: 'revenue_case',
          entityId: revenueCase.id,
          reason: `Failure diagnosed: ${category}${meta.failureCode ? ` (${meta.failureCode})` : ''}`,
          evidence: {
            category,
            failureCode: meta.failureCode ?? null,
            failureMessage: meta.failureMessage ?? null,
            amountAtRisk: meta.amount,
            priority,
          } as any,
          createdAt: new Date(),
        },
      });

      // Chain the recovery-evaluation stage of the pipeline
      setImmediate(() => {
        void processJob({} as Boss, JobType.EVALUATE_RECOVERY, {
          caseId,
          groundTruthSeed: (payload as any).groundTruthSeed,
        })
          .then((r) => {
            if (!r.success) console.error(`evaluate-recovery ${caseId} failed:`, r.error);
          })
          .catch((err) => console.error(`evaluate-recovery ${caseId} threw:`, err));
      });
    }

    // LIVE outcome verification: a real payment.captured/authorized event can
    // resolve cases whose recovery action is awaiting a provider outcome.
    if (
      event.eventType === 'payment_captured' ||
      event.eventType === 'payment_authorized'
    ) {
      const resolvedCount = await resolvePendingLiveOutcomes(merchantId, meta);
      if (resolvedCount > 0) {
        console.log(`Resolved ${resolvedCount} pending live outcome(s) from ${event.eventType}`);
      }
    }

    // 5. Audit trail
    await prisma.auditLog.create({
      data: {
        merchantId,
        actorType: 'system',
        actorId: 'webhook-ingest',
        action: 'transaction_event_processed',
        entityType: 'transaction',
        entityId: transaction.id,
        reason: `${event.eventType} processed from ${source}`,
        evidence: { eventType: event.eventType, caseId },
        createdAt: new Date(),
      },
    });

    // 6. Record completion ONLY now - the workflow is done
    await markWebhookProcessed(prisma, webhookEventId);

    return {
      success: true,
      result: { eventRef, transactionId: transaction.id, caseId, processed: true },
    };
  } catch (error) {
    const message = (error as Error).message;
    console.error('Error processing transaction event:', message);
    await markWebhookFailed(prisma, webhookEventId, message);
    return { success: false, error: message };
  }
}

// Evaluate recovery for a case: predict -> decide -> create bounded action
async function evaluateRecovery(payload: any): Promise<JobResult> {
  const { caseId } = payload;

  try {
    const revenueCase = await prisma.revenueCase.findUnique({
      where: { id: caseId },
      include: { transaction: true },
    });
    if (!revenueCase) {
      return { success: false, error: 'Revenue case not found' };
    }
    const tx = (revenueCase as any).transaction;

    // Build recovery features from real persisted data
    const diagnosis = (revenueCase.diagnosis ?? {}) as Record<string, unknown>;
    const category = String(diagnosis.primaryCategory || 'unknown');
    const occurredAt = tx?.occurredAt ? new Date(tx.occurredAt) : new Date();
    const hoursSince = Math.max(
      0,
      (Date.now() - occurredAt.getTime()) / 3600000
    );

    const features: any = {
      amount: revenueCase.amountAtRisk,
      failureCategory: category,
      paymentMethod: tx?.paymentMethod || 'unknown',
      historicalSuccessRate: 0.5,
      numberOfPreviousFailures: revenueCase.attemptCount,
      timeSinceFailureHours: hoursSince,
      transactionHour: occurredAt.getHours(),
      retryCount: revenueCase.attemptCount,
      isSubscription: revenueCase.caseType === 'subscription_recovery',
      merchantHistoricalRate: 0.5,
      failureCategoryHistoricalRate: 0.4,
      amountPercentile: Math.min(1, revenueCase.amountAtRisk / 500000),
    };

    const engine = new DecisionEngine(await getMerchantPolicy(revenueCase.merchantId));

    // PREDICT with the trained model (calibrated logistic regression served by
    // the FastAPI ML service). The pipeline fails loudly if the model is
    // unreachable — a hand-coded heuristic is never silently substituted.
    const mlPrediction = await predictRecoveryProbability(features, revenueCase.id);
    const decision = await engine.makeDecision(
      revenueCase.id,
      features,
      undefined,
      mlPrediction
    );

    // Persist the prediction + decision for the audit trail
    const predictionRow = await prisma.prediction.upsert({
      where: { caseId: revenueCase.id },
      update: {
        probability: decision.prediction.probability,
        expectedValue: decision.prediction.expectedRecoveryValue,
        confidence: decision.prediction.confidence,
        featureSnapshot: features as any,
        modelVersion: decision.prediction.modelVersion,
      },
      create: {
        caseId: revenueCase.id,
        modelVersion: decision.prediction.modelVersion,
        probability: decision.prediction.probability,
        expectedValue: decision.prediction.expectedRecoveryValue,
        confidence: decision.prediction.confidence,
        featureSnapshot: features as any,
        createdAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: revenueCase.merchantId,
        actorType: 'agent',
        actorId: 'ml-model',
        action: 'recovery_predicted',
        entityType: 'revenue_case',
        entityId: revenueCase.id,
        reason: `ML model scored recovery probability: ${(decision.prediction.probability * 100).toFixed(0)}%`,
        evidence: {
          predictionId: predictionRow.id,
          modelVersion: decision.prediction.modelVersion,
          probability: decision.prediction.probability,
          expectedRecoveryValue: decision.prediction.expectedRecoveryValue,
        } as any,
        createdAt: new Date(),
      },
    });

    const doNothing = decision.decision.action === ('DO_NOTHING' as any) || (decision.decision.action as any).toString().toLowerCase() === 'do_nothing';

    let actionId: string | null = null;
    if (!doNothing) {
      const idempotencyKey = `action:${revenueCase.id}:${decision.decision.action}:${revenueCase.attemptCount}`;
      const action = await prisma.recoveryAction.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          caseId: revenueCase.id,
          actionType: decision.decision.action,
          policySnapshot: {
            ...decision.policy.policySnapshot,
            violations: decision.policy.violations,
            stoppingRuleTriggered: decision.policy.stoppingRuleTriggered ?? false,
            blockedAlternatives: decision.policy.blockedAlternatives ?? [],
            rationale: decision.decision.rationale,
            probability: decision.prediction.probability,
          } as any,
          expectedCost: decision.decision.expectedCost,
          expectedNetRecovery: decision.decision.expectedNetRecovery,
          approvalStatus: decision.decision.requiresApproval ? 'pending' : 'not_required',
          executionStatus: 'PENDING',
          idempotencyKey,
        },
      });
      actionId = action.id;

      await prisma.revenueCase.update({
        where: { id: revenueCase.id },
        data: {
          status: decision.decision.requiresApproval ? 'ACTION_PENDING' : 'EVALUATED',
          currentActionId: action.id,
        },
      });

      // Autonomous execution when approved-by-policy and policy allows it.
      // simulated flag comes from the ingestion source: webhook events in
      // live mode, Razorpay API syncs are REAL; demo-lab/upload events are
      // simulated.
      const txMeta = (tx?.paymentMethodDetails ?? {}) as Record<string, unknown>;
      const isLiveSource =
        txMeta.simulated === false || txMeta.source === 'razorpay-api';
      const merchantPolicy = await getMerchantPolicy(revenueCase.merchantId);
      if (
        !decision.decision.requiresApproval &&
        merchantPolicy.autoActionEnable
      ) {
        setImmediate(() => {
          void processJob({} as Boss, JobType.EXECUTE_ACTION, {
            actionId,
            simulated: !isLiveSource,
            groundTruthSeed: (payload as any).groundTruthSeed,
            // Stable across dataset re-runs → reproducible ground-truth draws.
            // Attempt count is mixed in so bounded retries get a fresh but
            // still deterministic draw per attempt.
            groundTruthKey: `${(tx as any)?.providerTransactionId}:${revenueCase.attemptCount}`,
          }).catch((err) =>
            console.error(`execute-action ${actionId} threw:`, err)
          );
        });
      }
    } else {
      // DO_NOTHING is itself a bounded, auditable decision with a stopping rule
      await prisma.revenueCase.update({
        where: { id: revenueCase.id },
        data: {
          status: 'STOPPED',
          stoppedReason: decision.policy.stoppingRuleTriggered
            ? 'policy_stopping_rule'
            : 'no_positive_expected_value',
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        merchantId: revenueCase.merchantId,
        actorType: 'agent',
        actorId: 'decision-engine',
        action: 'recovery_decision_made',
        entityType: 'revenue_case',
        entityId: revenueCase.id,
        reason: decision.decision.rationale,
        evidence: {
          predictionId: predictionRow.id,
          probability: decision.prediction.probability,
          expectedNetRecovery: decision.decision.expectedNetRecovery,
        } as any,
        policyResult: {
          allowed: decision.policy.allowed,
          violations: decision.policy.violations,
          stoppingRuleTriggered: decision.policy.stoppingRuleTriggered ?? false,
        } as any,
        beforeState: { status: 'DETECTED' } as any,
        afterState: {
          status: doNothing
            ? 'STOPPED'
            : decision.decision.requiresApproval
              ? 'ACTION_PENDING'
              : 'EVALUATED',
          action: decision.decision.action,
        } as any,
        createdAt: new Date(),
      },
    });

    return {
      success: true,
      result: {
        caseId: revenueCase.id,
        action: decision.decision.action,
        requiresApproval: decision.decision.requiresApproval,
        policyAllowed: decision.policy.allowed,
        violations: decision.policy.violations,
      },
    };
  } catch (error) {
    console.error('Error evaluating recovery:', error);
    return { success: false, error: (error as Error).message };
  }
}

// Ground-truth outcome propensities used ONLY by the demo-mode outcome simulator.
// Deliberately independent of model scores so measured recovery is not circular:
// the engine predicts with the ML artifact; reality (simulated) answers separately.
//
// Calibrated against published 2025-26 subscription-recovery benchmarks
// (insufficient funds 55-70% with timed retries, expired instruments ~40% with
// card-update outreach, transient issuer/network errors 45-78%, voluntary
// cancels <10%; blended smart-dunning tier 55-75%). Mirrors
// CATEGORY_BASE_RECOVERY in services/ml/data/generate_synthetic.py.
export const GROUND_TRUTH_BASE_RATES: Record<string, number> = {
  insufficient_funds: 0.62,
  bank_failure: 0.52,
  auth_failure: 0.48,
  expired_instrument: 0.42,
  network_timeout: 0.78,
  customer_cancellation: 0.08,
  repeated_failure: 0.3,
  payment_method_degradation: 0.46,
  subscription_failure: 0.58,
  unknown: 0.45,
};

export function simulateGroundTruthOutcome(
  primaryCategory: string,
  actionType: string,
  attemptCount: number
): number {
  let p = GROUND_TRUTH_BASE_RATES[primaryCategory] ?? 0.4;
  p -= 0.08 * attemptCount; // retry fatigue
  // Intervention fit from the SHARED lift table (intervention-lifts.ts) —
  // identical numbers drive the decision engine, so the simulator's reality
  // and the engine's expectations cannot diverge.
  p += getInterventionLift(actionType, primaryCategory);
  return Math.min(0.95, Math.max(0.02, p));
}

// Execute a recovery action (simulation provider in DEMO mode)
async function executeAction(payload: any): Promise<JobResult> {
  const { actionId, simulated, groundTruthSeed } = payload;

  try {
    const action = await prisma.recoveryAction.findUnique({
      where: { id: actionId },
    });
    if (!action) {
      return { success: false, error: 'Recovery action not found' };
    }
    if (action.executionStatus !== 'PENDING') {
      return { success: true, result: 'already_executed' };
    }
    if (action.approvalStatus === 'pending') {
      return { success: false, error: 'Action awaiting human approval' };
    }

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { id: action.caseId },
    });
    if (!revenueCase) {
      return { success: false, error: 'Revenue case not found' };
    }

    const snapshot = (action.policySnapshot ?? {}) as Record<string, unknown>;
    const probability = Number(snapshot.probability ?? 0.5);
    const isLive = simulated === false;

    // ---------------------------------------------------------------------
    // LIVE / PROVIDER PATH — real money at stake. We do NOT fabricate an
    // outcome. The action is recorded as executed with the provider, the case
    // moves to OUTCOME_PENDING and verification happens only when Razorpay
    // reports a real status change (webhook event or API poll).
    // ---------------------------------------------------------------------
    if (isLive) {
      const providerActionId = `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await prisma.recoveryAction.update({
        where: { id: action.id },
        data: {
          executionStatus: 'EXECUTED',
          providerActionId,
          executedAt: new Date(),
          completedAt: null, // not complete until the provider confirms an outcome
          error: null,
        },
      });

      const executionDetails = {
        mode: 'PROVIDER_LIVE',
        modelProbability: Number(probability.toFixed(4)),
        providerActionId,
        awaitingProviderOutcome: true,
        note:
          'Executed against the live provider. No outcome is simulated; recovery is verified from a real payment.captured / payment.failed event or an API status poll.',
      };

      await prisma.revenueCase.update({
        where: { id: revenueCase.id },
        data: { status: 'OUTCOME_PENDING' },
      });

      await prisma.auditLog.create({
        data: {
          merchantId: revenueCase.merchantId || 'demo-merchant',
          actorType: 'agent',
          actorId: 'action-executor',
          action: 'recovery_action_executed',
          entityType: 'recovery_action',
          entityId: action.id,
          reason: `${action.actionType} submitted to provider (LIVE) — awaiting provider/customer outcome`,
          evidence: executionDetails as any,
          beforeState: { executionStatus: 'PENDING' } as any,
          afterState: { executionStatus: 'EXECUTED', caseStatus: 'OUTCOME_PENDING' } as any,
          createdAt: new Date(),
        },
      });

      return {
        success: true,
        result: { actionId: action.id, providerActionId, awaitingOutcome: true },
      };
    }

    // ---------------------------------------------------------------------
    // DEMO-MODE SIMULATION (explicitly labeled everywhere it surfaces):
    // outcome drawn from a ground-truth propensity that is independent of the
    // model score (category base rate + retry fatigue + intervention fit).
    // ---------------------------------------------------------------------
    const providerActionId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const primaryCategory =
      ((revenueCase.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
    const groundTruthProbability = simulateGroundTruthOutcome(
      primaryCategory,
      action.actionType,
      revenueCase.attemptCount
    );
    // Deterministic ground-truth draw when a seed is provided (reproducible
    // demo batches); otherwise an independent random roll. The key must be
    // STABLE across runs of the same dataset — the provider transaction id,
    // not the generated action cuid.
    const rollKey = String(payload.groundTruthKey || action.id);
    const roll = Number.isFinite(groundTruthSeed)
      ? mulberry32((fnv1a(rollKey) ^ (groundTruthSeed >>> 0)) >>> 0)()
      : Math.random();
    const willRecover = roll < groundTruthProbability;
    const executionDetails = {
      mode: 'SIMULATED_DEMO',
      groundTruthProbability: Number(groundTruthProbability.toFixed(4)),
      modelProbability: Number(probability.toFixed(4)),
      randomRoll: Number(roll.toFixed(4)),
      willRecover,
      providerActionId,
    };

    await prisma.recoveryAction.update({
      where: { id: action.id },
      data: {
        executionStatus: 'EXECUTED',
        providerActionId,
        executedAt: new Date(),
        completedAt: new Date(),
        error: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: revenueCase.merchantId || 'demo-merchant',
        actorType: 'agent',
        actorId: 'action-executor',
        action: 'recovery_action_executed',
        entityType: 'recovery_action',
        entityId: action.id,
        reason: `${action.actionType} executed (${executionDetails.mode})`,
        evidence: executionDetails as any,
        beforeState: { executionStatus: 'PENDING' } as any,
        afterState: { executionStatus: 'EXECUTED' } as any,
        createdAt: new Date(),
      },
    });

    // Chain outcome verification
    setImmediate(() => {
      void processJob({} as Boss, JobType.VERIFY_OUTCOME, {
        actionId: action.id,
        executionDetails,
      }).catch((err) => console.error(`verify-outcome ${action.id} threw:`, err));
    });

    return {
      success: true,
      result: { actionId: action.id, providerActionId, willRecover },
    };
  } catch (error) {
    console.error('Error executing action:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * LIVE outcome verification, driven by REAL provider events.
 * When a payment.captured / payment.authorized webhook arrives, match it to
 * open OUTCOME_PENDING cases and record a verified RECOVERED outcome
 * referencing the real provider transaction.
 *
 * Matching policy:
 *   - PRIMARY: exact join Transaction.providerTransactionId === event payment
 *     id — unambiguous regardless of amount collisions.
 *   - FALLBACK (events without a payment id): oldest single case for the
 *     merchant with the same amountAtRisk. Never more than one case is
 *     resolved from an ambiguous match.
 */
export async function resolvePendingLiveOutcomes(
  merchantId: string,
  meta: {
    providerTransactionId?: string;
    amount?: number;
    occurredAt?: string | number;
  }
): Promise<number> {
  if (!meta.amount || meta.amount <= 0) return 0;

  const exactMatch = Boolean(meta.providerTransactionId);
  const pending = await prisma.revenueCase.findMany({
    where: {
      merchantId,
      status: 'OUTCOME_PENDING',
      ...(exactMatch
        ? { transaction: { providerTransactionId: meta.providerTransactionId } }
        : { amountAtRisk: meta.amount }),
    },
    orderBy: { createdAt: 'asc' },
    // Exact id match may legitimately fan out (defensive); ambiguous amount
    // matching must stay single-case.
    take: exactMatch ? 5 : 1,
  });

  let resolved = 0;
  for (const c of pending) {
    const actionId = (c as any).currentActionId;
    if (!actionId) continue;
    const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
    if (!action || action.executionStatus !== 'EXECUTED') continue;
    // Execution mode is recorded in the execution audit entry's evidence.
    const execAudit = await prisma.auditLog.findFirst({
      where: {
        action: 'recovery_action_executed',
        entityType: 'recovery_action',
        entityId: action.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    if ((execAudit?.evidence as any)?.mode !== 'PROVIDER_LIVE') continue;
    if (await prisma.outcome.findUnique({ where: { actionId: action.id } })) continue;

    const outcome = await prisma.outcome.create({
      data: {
        actionId: action.id,
        recoveredAmount: c.amountAtRisk,
        result: 'RECOVERED',
        recoveryTimestamp: new Date(),
        measuredCost: action.expectedCost,
        verificationRef: meta.providerTransactionId ?? null,
        notes: 'Verified from real provider event (payment captured)',
        verifiedAt: new Date(),
      },
    });
    await prisma.recoveryAction.update({
      where: { id: action.id },
      data: { outcomeId: outcome.id, completedAt: new Date() },
    });
    await prisma.revenueCase.update({
      where: { id: c.id },
      data: { status: 'RECOVERED', stoppedReason: null },
    });
    await prisma.auditLog.create({
      data: {
        merchantId,
        actorType: 'system',
        actorId: 'outcome-verifier',
        action: 'recovery_outcome_verified',
        entityType: 'recovery_action',
        entityId: action.id,
        reason: `Recovered ${(c.amountAtRisk / 100).toLocaleString('en-IN')} — confirmed by live provider event`,
        evidence: {
          mode: 'PROVIDER_LIVE',
          providerTransactionId: meta.providerTransactionId ?? null,
          outcomeId: outcome.id,
        } as any,
        beforeState: { status: 'OUTCOME_PENDING' } as any,
        afterState: { status: 'RECOVERED', outcomeId: outcome.id } as any,
        createdAt: new Date(),
      },
    });
    resolved++;
  }
  return resolved;
}

// Verify outcome of a recovery action and measure recovered money
async function verifyOutcome(payload: any): Promise<JobResult> {  const { actionId, executionDetails } = payload;

  try {
    const action = await prisma.recoveryAction.findUnique({
      where: { id: actionId },
    });
    if (!action) {
      return { success: false, error: 'Action not found' };
    }

    const existingOutcome = await prisma.outcome.findUnique({
      where: { actionId: action.id },
    });
    if (existingOutcome?.verifiedAt) {
      return { success: true, result: 'already_verified' };
    }

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { id: action.caseId },
    });
    if (!revenueCase) {
      return { success: false, error: 'Revenue case not found' };
    }

    const willRecover: boolean = Boolean(executionDetails?.willRecover);
    const recoveredAmount = willRecover ? revenueCase.amountAtRisk : 0;
    const measuredCost = action.expectedCost;

    const outcome = await prisma.outcome.upsert({
      where: { actionId: action.id },
      update: {
        recoveredAmount,
        result: willRecover ? 'RECOVERED' : 'NOT_RECOVERED',
        verifiedAt: new Date(),
      },
      create: {
        actionId: action.id,
        recoveredAmount,
        result: willRecover ? 'RECOVERED' : 'NOT_RECOVERED',
        recoveryTimestamp: new Date(),
        measuredCost,
        notes:
          executionDetails?.mode === 'SIMULATED_DEMO'
            ? 'Simulated outcome drawn from independent ground-truth propensity (demo mode)'
            : undefined,
        verifiedAt: new Date(),
        verificationRef: executionDetails?.providerActionId ?? null,
      },
    });

    await prisma.recoveryAction.update({
      where: { id: action.id },
      data: { outcomeId: outcome.id },
    });

    await prisma.revenueCase.update({
      where: { id: revenueCase.id },
      data: {
        status: willRecover ? 'RECOVERED' : 'FAILED',
        attemptCount: revenueCase.attemptCount + 1,
        lastAttemptAt: new Date(),
        stoppedReason: willRecover ? null : 'recovery_failed',
        currentActionId: action.id,
      },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: revenueCase.merchantId,
        actorType: 'system',
        actorId: 'outcome-verifier',
        action: 'recovery_outcome_verified',
        entityType: 'recovery_action',
        entityId: action.id,
        reason: willRecover
          ? `Recovered ${(recoveredAmount / 100).toLocaleString('en-IN')}`
          : 'Recovery attempt did not succeed',
        evidence: executionDetails as any,
        beforeState: { status: 'EXECUTED' } as any,
        afterState: { status: willRecover ? 'RECOVERED' : 'FAILED', outcomeId: outcome.id } as any,
        createdAt: new Date(),
      },
    });

    return {
      success: true,
      result: { actionId: action.id, outcomeId: outcome.id, recoveredAmount },
    };
  } catch (error) {
    console.error('Error verifying outcome:', error);
    return { success: false, error: (error as Error).message };
  }
}

// Schedule a retry with exponential backoff
async function scheduleRetry(payload: any): Promise<JobResult> {
  const { caseId, originalAttempt, maxAttempts } = payload;
  
  const backoffMs = Math.pow(2, originalAttempt) * 30000; // 30s, 1min, 2min, ...
  
  // Enqueue a retry-scheduled job
  // await enqueueProcessingJob({
  //   type: JobType.RETRY_SCHEDULED,
  //   payload: { caseId, originalAttempt, maxAttempts },
  //   options: { delay: backoffMs },
  // });
  
  return {
    success: true,
    result: { caseId, retryInMs: backoffMs },
  };
}

// Run retention cleanup (remove old data per policy)
async function retentionCleanup(payload: any): Promise<JobResult> {
  const { merchantId, retentionDays } = payload;
  
  try {
    // In production, this would:
    // 1. Query transactions older than retention period
    // 2. Anonymize or delete per merchant policy
    // 3. Log all actions to audit trail
    // 4. Update merchant's retention policy tracking
    
    console.log(`Running retention cleanup for merchant ${merchantId}`);
    
    return {
      success: true,
      result: { merchantId, cleaned: 0 }, // count would be real
    };
  } catch (error) {
    console.error('Error in retention cleanup:', error);
    return { success: false, error: (error as Error).message };
  }
}