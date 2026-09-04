// Job Queue - PostgreSQL-backed queue using pg-boss
// Handles async job processing for webhook events, recovery evaluations, etc.

import * as PgBossModule from 'pg-boss';
import {
  ensureDemoMerchant,
  markWebhookProcessing,
  markWebhookProcessed,
  markWebhookFailed,
} from '../../database/src/idempotency';
import { prisma, writeNotification } from '../../database';
import { DecisionEngine, DEFAULT_MERCHANT_POLICY } from '../../policies/src';
import type { MerchantPolicy } from '../../policies/src';
import { getInterventionLift } from '../../policies/src/intervention-lifts';
import { predictRecoveryProbability, logTrainingData, triggerRetrain, observeDriftMetrics } from './ml-client';
import { AgentOrchestrator } from '../../agent/src/orchestrator';
import { callLLMReasoning, type LLMCallResult } from '../../agent/src/llm/client';
import { dispatchLiveAction } from './razorpay-live';
import { setQueueDepth } from './metrics';
import { RETRY_WINDOWS, calculateNextRetryTime } from '../../domain/src/services/retry-sequencer';

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
  CHECKOUT_RECOVERY = 'checkout-recovery',
  RECEIVABLES_CHASE = 'receivables-chase',
  PROMISE_CHECK = 'promise-check',
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
      // Periodically observe queue depths for Prometheus metrics (via direct DB count)
      const depthInterval = setInterval(async () => {
        try {
          const rows = await prisma.$queryRawUnsafe<{ name: string; pending: bigint }[]>(
            `SELECT name, COUNT(*) AS pending FROM pgboss.job WHERE completedOn IS NULL AND name IN ('process-transaction-event','verify-outcome') GROUP BY name`
          );
          for (const r of rows) setQueueDepth(r.name, Number(r.pending));
        } catch {
          // depth observation must never break the queue
        }
        // Also observe ML drift metrics (best-effort, every 60s)
        try {
          await observeDriftMetrics();
        } catch {
          // drift observation must never break the queue
        }
      }, 30_000);
      if (typeof depthInterval.unref === 'function') depthInterval.unref();

      const promiseCheckInterval = setInterval(async () => {
        try {
          await processPromiseCheck({});
        } catch {
          // promise check must never break the queue
        }
      }, 300_000);
      if (typeof promiseCheckInterval.unref === 'function') promiseCheckInterval.unref();

      // Consume due retry schedules every 5 minutes so failed recovery
      // actions are retried per the backoff policy instead of stalling.
      const retryConsumeInterval = setInterval(async () => {
        try {
          await consumeRetrySchedules();
        } catch {
          // retry consumption must never break the queue
        }
      }, 300_000);
      if (typeof retryConsumeInterval.unref === 'function') retryConsumeInterval.unref();

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
    case JobType.CHECKOUT_RECOVERY:
      return await processCheckoutRecovery(payload);
    case JobType.RECEIVABLES_CHASE:
      return await processReceivablesChase(payload);
    case JobType.PROMISE_CHECK:
      return await processPromiseCheck(payload);
    default:
      console.warn(`Unknown job type: ${jobType}`);
      return { success: false, error: `Unknown job type: ${jobType}` };
  }
}

// Process transaction event from webhook
async function processTransactionEvent(payload: any): Promise<JobResult> {
  const { event, eventRef, webhookEventId, source, simulated, merchantId: payloadMerchantId } = payload;

  try {
    // 1. Transition durable webhook state: RECEIVED -> PROCESSING
    await markWebhookProcessing(prisma, webhookEventId);

    const meta = event?.safeMetadata ?? {};
    const providerTransactionId: string | undefined = meta.providerTransactionId;
    const occurredAt: Date = meta.occurredAt ? new Date(meta.occurredAt) : new Date();

    if (!providerTransactionId || typeof meta.amount !== 'number') {
      throw new Error('Event missing providerTransactionId or amount');
    }

    // 2. Merchant attribution comes from the job payload (set by the caller
    //    that authenticated the webhook). The demo tenant is used ONLY when
    //    the caller intentionally omitted a merchant (dev/experiment paths).
    //    A real signed webhook must never be silently attributed to the demo
    //    merchant — that would break multi-tenant isolation.
    let merchantId =
      typeof payloadMerchantId === 'string' && payloadMerchantId ? payloadMerchantId : null;
    if (!merchantId) {
      merchantId = await ensureDemoMerchant(prisma);
    } else {
      // Ensure the FK target exists without ever overriding attribution.
      await ensureDemoMerchant(prisma, merchantId);
    }

    // 3. Persist transaction (idempotent on providerTransactionId).
    //    Stale-event guard: if the provider already told us this payment was
    //    captured, a late out-of-order payment_failed must NOT regress it back
    //    to a failed state. Webhooks arrive out of order, so we only apply a
    //    failed status when the transaction isn't already a terminal success.
    const existingTx = await prisma.transaction.findUnique({
      where: { providerTransactionId },
    });
    const existingStatus = existingTx?.status?.toUpperCase();
    const isAlreadyCaptured =
      existingStatus === 'CAPTURED' || existingStatus === 'AUTHORIZED';
    const incomingIsFailed = String(meta.status ?? '').toUpperCase().includes('FAILED');
    // Only overwrite the status when it isn't a stale failure overriding a success
    const safeStatus =
      existingTx && incomingIsFailed && isAlreadyCaptured
        ? existingTx.status
        : (meta.status ?? 'unknown');

    const transaction = await prisma.transaction.upsert({
      where: { providerTransactionId },
      update: {
        status: safeStatus,
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

      // Human-friendly case reference, e.g. RP-1042.
      // Generated inside a retry loop: the ref has a unique DB constraint, so
      // if two concurrent jobs pick the same candidate, the loser retries with
      // the next number. Max 3 attempts — if that fails something is wrong.
      let caseRef: string | undefined;
      let revenueCase: { id: string; merchantId: string; amountAtRisk: number; ref: string | null } | null = null;
      const baseCount = await prisma.revenueCase.count();
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = `RP-${1001 + baseCount + attempt}`;
        try {
          revenueCase = await prisma.revenueCase.upsert({
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
              ref: candidate,
              createdAt: new Date(),
            },
          });
          caseRef = candidate;
          break;
        } catch (err: any) {
          if (err?.code === 'P2002' && err?.meta?.target?.includes('ref')) {
            // Candidate ref was taken by a concurrent job — retry.
            continue;
          }
          throw err;
        }
      }
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

    // LIVE outcome verification: only payment_captured resolves a pending case
    // as RECOVERED. payment_authorized means the bank approved the hold but has
    // NOT yet captured funds — marking it recovered would be financially wrong.
    if (event.eventType === 'payment_captured') {
      const resolvedCount = await resolvePendingLiveOutcomes(merchantId, meta);
      if (resolvedCount > 0) {
        console.log(`Resolved ${resolvedCount} pending live outcome(s) from payment_captured`);
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
      // v4 context-aware features: what can be derived from persisted data;
      // everything else falls back to defaults in toMlFeatures.
      dayOfWeek: occurredAt.getDay(),
      merchantVertical: (revenueCase as any).merchantVertical || 'other',
      planTier: (revenueCase as any).planTier ?? 0,
      customerTenureDays: (revenueCase as any).customerTenureDays ?? 365,
      contactChannel: (revenueCase as any).contactChannel || 'none',
      intervention: 'none',
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
      mlPrediction,
      {
        attemptCount: revenueCase.attemptCount,
        contactCount: revenueCase.attemptCount,
        caseAgeHours: Math.max(
          0,
          (Date.now() - new Date(revenueCase.createdAt).getTime()) / 3600000
        ),
        lastAttemptAt: revenueCase.lastAttemptAt ?? null,
        customerDeclined:
          revenueCase.stoppedReason === 'customer_declined' ||
          // A customer_cancellation diagnosis IS the customer walking away —
          // respect it via the stopOnCustomerDecline guardrail instead of
          // chasing a declined payment.
          category === 'customer_cancellation' ||
          Boolean((revenueCase as any).customerDeclined),
        repeatedFailures: revenueCase.attemptCount >= 3,
      }
    );

    // The Revenue Recovery Agent orchestrates the reasoning phases for this
    // case: diagnose → retrieve context → score (real model prediction) →
    // propose → explain. It NEVER executes money actions — the deterministic
    // DecisionEngine (above) is the authoritative gate and the executor (below)
    // is what touches the provider. The agent's output is persisted as the
    // explainable diagnosis + audit evidence.
    let agentReasoning: {
      diagnosis: { category: string; confidence: number; evidence: string[] };
      prediction: any;
      proposedAction: string;
      rationale: string;
      toolCalls: string[];
    } | null = null;
    try {
      const agent = new AgentOrchestrator(await getMerchantPolicy(revenueCase.merchantId));
      agentReasoning = await agent.orchestrate({
        caseId: revenueCase.id,
        merchantId: revenueCase.merchantId,
        features: features as any,
        externalPrediction: mlPrediction,
        failureMessage: (tx?.failureMessage as string) || undefined,
        rawDiagnosis: { primaryCategory: category, confidence: mlPrediction?.confidence ?? 0 },
      });
    } catch (err) {
      // Orchestration is advisory; a failure here must never block the bounded
      // deterministic recovery loop.
      console.error(`agent.orchestrate failed for ${revenueCase.id}:`, err);
    }

    // ── LLM reasoning layer ──────────────────────────────────────────────────
    // The LLM proposes a diagnosis + recommendation + human-readable rationale.
    // It NEVER moves money — the DecisionEngine result and the executor remain
    // authoritative. If the LLM is unreachable or its output conflicts with
    // the policy decision, the deterministic path wins and the audit records
    // the override.
    let llmResult: LLMCallResult | null = null;
    let llmSucceeded = false;
    try {
      const merchantPolicy = await getMerchantPolicy(revenueCase.merchantId);
      llmResult = await callLLMReasoning({
        features: features as any,
        mlProbability: decision.prediction.probability,
        mlConfidence: decision.prediction.confidence,
        modelVersion: decision.prediction.modelVersion,
        failureMessage: (tx?.failureMessage as string) || undefined,
        merchantPolicy: {
          maxRetries: merchantPolicy.maximumRetryCount,
          maxRetryDelayMs: merchantPolicy.cooldownPeriod * 3600000,
          approvalThreshold: merchantPolicy.humanApprovalThreshold,
          maxIncentive: merchantPolicy.maximumIncentiveAmount,
        },
      });
      if (llmResult) llmSucceeded = true;
    } catch (err) {
      // LLM is advisory only — failure here is logged, not fatal.
      console.error(`[llm] reasoning call failed for ${revenueCase.id}:`, (err as Error).message);
    }

    // Merge LLM output into agentReasoning. If the LLM provided a
    // diagnosis or rationale, prefer it over the deterministic fallback
    // for the audit trail. If the LLM's recommended action differs from
    // the policy-approved action, the policy wins (always).
    if (llmResult && agentReasoning) {
      agentReasoning.rationale = llmResult.output.rationale || agentReasoning.rationale;
      agentReasoning.diagnosis = llmResult.output.diagnosis;
    } else if (llmResult && !agentReasoning) {
      // Agent orchestration failed but LLM succeeded — synthesize agentReasoning
      agentReasoning = {
        diagnosis: llmResult.output.diagnosis,
        prediction: mlPrediction,
        proposedAction: llmResult.output.recommendedAction,
        rationale: llmResult.output.rationale,
        toolCalls: ['callLLMReasoning'],
      };
    }

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

    // Agent-orchestrated reasoning is persisted as auditable evidence. The
    // agent proposes and explains; the deterministic engine decides and the
    // executor acts — so this entry records the AI's recommendation for the
    // audit trail without conferring any authority to move money.
    if (agentReasoning) {
      await prisma.auditLog.create({
        data: {
          merchantId: revenueCase.merchantId,
          actorType: 'agent',
          actorId: 'revenue-recovery-agent',
          action: 'agent_orchestrated',
          entityType: 'revenue_case',
          entityId: revenueCase.id,
          reason: agentReasoning.rationale,
          evidence: {
            proposedAction: agentReasoning.proposedAction,
            finalDecision: decision.decision.action,
            toolCalls: agentReasoning.toolCalls,
            diagnosis: agentReasoning.diagnosis,
            policyAllowed: decision.policy.allowed,
            violations: decision.policy.violations,
            llm: llmSucceeded
              ? { provider: llmResult!.provider, model: llmResult!.model, succeeded: true }
              : { succeeded: false, fallback: 'deterministic' },
          } as any,
          createdAt: new Date(),
        },
      });
    }

    const doNothing = decision.decision.action === ('DO_NOTHING' as any) || (decision.decision.action as any).toString().toLowerCase() === 'do_nothing';

    let actionId: string | null = null;
    if (!doNothing) {
      const skipExecution = (payload as any).skipExecution === true;
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
          // Admin-initiated retries always require approval
          approvalStatus: skipExecution || decision.decision.requiresApproval ? 'pending' : 'not_required',
          executionStatus: 'PENDING',
          idempotencyKey,
        },
      });
      actionId = action.id;

      await prisma.revenueCase.update({
        where: { id: revenueCase.id },
        data: {
          status: skipExecution || decision.decision.requiresApproval ? 'ACTION_PENDING' : 'EVALUATED',
          currentActionId: action.id,
        },
      });

      if (skipExecution || decision.decision.requiresApproval) {
        await writeNotification(prisma, {
          merchantId: revenueCase.merchantId,
          type: 'action_approval_required',
          severity: 'warning',
          title: 'Recovery action needs approval',
          message: `Case ${revenueCase.ref ?? revenueCase.id.slice(-6)} is ${(revenueCase.amountAtRisk / 100).toLocaleString('en-IN')} at risk and has a proposed action queueing for review.`,
          entityType: 'RevenueCase',
          entityId: revenueCase.id,
        });
      }

      // Autonomous execution when approved-by-policy and policy allows it.
      // simulated flag comes from the ingestion source: webhook events in
      // live mode, Razorpay API syncs are REAL; demo-lab/upload events are
      // simulated.
      const txMeta = (tx?.paymentMethodDetails ?? {}) as Record<string, unknown>;
      const isLiveSource =
        txMeta.simulated === false || txMeta.source === 'razorpay-api';
      const merchantPolicy = await getMerchantPolicy(revenueCase.merchantId);
      // Admin-initiated retries use skipExecution=true to produce a proposal
      // without auto-executing — the admin reviews and approves first.
      if (skipExecution) {
        // Force the action into approval-required state so the admin sees a
        // proposal they can review before anything runs.
        await prisma.revenueCase.update({
          where: { id: revenueCase.id },
          data: { status: 'ACTION_PENDING' },
        });
        await prisma.recoveryAction.update({
          where: { id: actionId },
          data: { approvalStatus: 'pending' },
        });
      } else if (
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
    // ── Atomic claim: PENDING → EXECUTING ────────────────────────────────────
    // Use an atomic updateMany with a WHERE guard instead of read→check→write
    // to prevent two workers from concurrently executing the same action.
    const claimed = await prisma.recoveryAction.updateMany({
      where: { id: actionId, executionStatus: 'PENDING' },
      data: { executionStatus: 'EXECUTING' },
    });
    if (claimed.count === 0) {
      // Either already executed/executing or action doesn't exist
      const existing = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
      if (!existing) return { success: false, error: 'Recovery action not found' };
      return { success: true, result: 'already_executed' };
    }

    const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
    if (!action) return { success: false, error: 'Recovery action not found' };

    if (action.approvalStatus === 'pending') {
      // Roll back the claim — action needs human approval
      await prisma.recoveryAction.updateMany({
        where: { id: actionId, executionStatus: 'EXECUTING' },
        data: { executionStatus: 'PENDING' },
      });
      return { success: false, error: 'Action awaiting human approval' };
    }

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { id: action.caseId },
      include: { transaction: true },
    });
    if (!revenueCase) {
      return { success: false, error: 'Revenue case not found' };
    }

    const snapshot = (action.policySnapshot ?? {}) as Record<string, unknown>;
    const probability = Number(snapshot.probability ?? 0.5);
    const isLive = simulated === false;

    // ---------------------------------------------------------------------
    // LIVE / PROVIDER PATH — real money at stake. A provider reference is
    // NEVER fabricated here: a real Razorpay Payment Link is created (and its
    // real id used) when credentials exist for a payment-collection action.
    // Any other case is recorded honestly without a fake provider id, and a
    // hard dispatch error bubbles up as a failed job instead of pretending.
    // ---------------------------------------------------------------------
    if (isLive) {
      const dispatch = await dispatchLiveAction({
        merchantId: revenueCase.merchantId || 'demo-merchant',
        actionType: action.actionType,
        amountPaise: revenueCase.amountAtRisk,
        currency: 'INR',
        description: `RevenuePulse recovery — ${action.actionType} (case ${revenueCase.ref ?? revenueCase.id})`,
        customerEmail: (revenueCase.transaction as any)?.paymentMethodDetails?.email,
        customerPhone: (revenueCase.transaction as any)?.paymentMethodDetails?.phone,
        caseRef: revenueCase.ref ?? revenueCase.id,
      });

      // Hard failure: we must not claim a live execution we could not do.
      if (dispatch.status === 'error') {
        return { success: false, error: dispatch.error };
      }

      const providerActionId = dispatch.providerActionId ?? null;
      const paymentUrl = dispatch.paymentUrl ?? null;

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
        paymentUrl,
        awaitingProviderOutcome: true,
        note:
          dispatch.status === 'dispatched'
            ? `Real Razorpay Payment Link created (${providerActionId}). No outcome is simulated; recovery is verified only from a real payment event or API status poll.`
            : `Recorded as executed for ${action.actionType}. Razorpay has no API dispatch for this action type in this MVP — no payment was charged, no provider id fabricated; recovery is verified only from real provider events.`,
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
          reason:
            dispatch.status === 'dispatched'
              ? `${action.actionType} executed via real Razorpay Payment Link (${providerActionId}) — awaiting provider/customer outcome`
              : `${action.actionType} recorded (LIVE) — no provider dispatch in MVP, awaiting real provider/customer outcome`,
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

    if (!willRecover) {
      const category =
        ((revenueCase.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
      const retryWindow = RETRY_WINDOWS[category];
      if (retryWindow) {
        const schedule = calculateNextRetryTime(retryWindow, revenueCase.attemptCount);
        // Use upsert: RetrySchedule.caseId is UNIQUE, so a second failed
        // attempt on the same case must update the existing schedule rather
        // than creating a duplicate (which would hit a constraint violation).
        await prisma.retrySchedule.upsert({
          where: { caseId: revenueCase.id },
          create: {
            caseId: revenueCase.id,
            merchantId: revenueCase.merchantId,
            failureCategory: category,
            retryWindow: retryWindow as any,
            currentRetry: schedule.attempt,
            maxRetries: retryWindow.maxRetries,
            nextRetryAt: new Date(schedule.retryAt),
            status: 'scheduled',
            createdAt: new Date(),
          },
          update: {
            currentRetry: schedule.attempt,
            maxRetries: retryWindow.maxRetries,
            nextRetryAt: new Date(schedule.retryAt),
            status: 'scheduled',
            lastRetryAt: new Date(),
          },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: revenueCase.merchantId,
            actorType: 'system',
            actorId: 'retry-sequencer',
            action: 'retry_scheduled',
            entityType: 'revenue_case',
            entityId: revenueCase.id,
            reason: `Retry ${schedule.attempt}/${retryWindow.maxRetries} scheduled for ${schedule.retryAt} (${category})`,
            evidence: {
              category,
              attempt: schedule.attempt,
              maxRetries: retryWindow.maxRetries,
              nextRetryAt: schedule.retryAt,
              delayHours: schedule.delayHours,
            } as any,
            createdAt: new Date(),
          },
        });
      }
    }

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
 * When a payment.captured webhook arrives, match it to open OUTCOME_PENDING
 * cases and record a verified RECOVERED outcome referencing the real provider
 * transaction.
 *
 * Matching policy (tried in order, first match wins):
 *   1. RecoveryAction.providerActionId — the Payment Link id (plink_xxx)
 *      stored when the live action was dispatched. A customer paying through
 *      a recovery Payment Link produces a NEW providerTransactionId, so
 *      exact transaction id matching would miss it. Razorpay includes the
 *      Payment Link id in payment_link webhook payloads; we also accept it
 *      from the event metadata if present.
 *   2. Exact join Transaction.providerTransactionId === event payment id.
 *   3. Fallback (events without a payment id): oldest single case for the
 *      merchant with the same amountAtRisk. Never more than one case is
 *      resolved from an ambiguous match.
 */
export async function resolvePendingLiveOutcomes(
  merchantId: string,
  meta: {
    providerTransactionId?: string;
    amount?: number;
    occurredAt?: string | number;
    paymentLinkId?: string;
  }
): Promise<number> {
  if (!meta.amount || meta.amount <= 0) return 0;

  let resolved = 0;

  // ── 1. Match by Payment Link id (most specific for recovery-initiated payments) ──
  if (meta.paymentLinkId && resolved === 0) {
    const plinkCases = await prisma.revenueCase.findMany({
      where: {
        merchantId,
        status: 'OUTCOME_PENDING',
        currentActionId: { not: null },
      },
      take: 10,
    });
    for (const c of plinkCases) {
      const actionId = (c as any).currentActionId;
      if (!actionId) continue;
      const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
      if (!action || action.executionStatus !== 'EXECUTED') continue;
      if (action.providerActionId !== meta.paymentLinkId) continue;
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

      await recordRecoveredOutcome(merchantId, c, action, meta.providerTransactionId);
      resolved++;
    }
    if (resolved > 0) return resolved;
  }

  // ── 2. Match by exact Transaction.providerTransactionId ──
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
    take: exactMatch ? 5 : 1,
  });

  for (const c of pending) {
    const actionId = (c as any).currentActionId;
    if (!actionId) continue;
    const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
    if (!action || action.executionStatus !== 'EXECUTED') continue;
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

    await recordRecoveredOutcome(merchantId, c, action, meta.providerTransactionId);
    resolved++;
  }
  return resolved;
}

/** Persist a verified recovered outcome + audit trail for a matched case. */
async function recordRecoveredOutcome(
  merchantId: string,
  revenueCase: any,
  action: { id: string; expectedCost: number },
  providerTransactionId?: string
): Promise<void> {
  const outcome = await prisma.outcome.create({
    data: {
      actionId: action.id,
      recoveredAmount: revenueCase.amountAtRisk,
      result: 'RECOVERED',
      recoveryTimestamp: new Date(),
      measuredCost: action.expectedCost,
      verificationRef: providerTransactionId ?? null,
      notes: 'Verified from real provider event (payment captured)',
      verifiedAt: new Date(),
    },
  });
  await prisma.recoveryAction.update({
    where: { id: action.id },
    data: { outcomeId: outcome.id, completedAt: new Date() },
  });
  await prisma.revenueCase.update({
    where: { id: revenueCase.id },
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
      reason: `Recovered ${(revenueCase.amountAtRisk / 100).toLocaleString('en-IN')} — confirmed by live provider event`,
      evidence: {
        mode: 'PROVIDER_LIVE',
        providerTransactionId: providerTransactionId ?? null,
        outcomeId: outcome.id,
      } as any,
      beforeState: { status: 'OUTCOME_PENDING' } as any,
      afterState: { status: 'RECOVERED', outcomeId: outcome.id } as any,
      createdAt: new Date(),
    },
  });
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

    // ── In-app notification for the outcome ──────────────────────────────────
    await writeNotification(prisma, {
      merchantId: revenueCase.merchantId,
      type: willRecover ? 'recovery_recovered' : 'recovery_failed',
      severity: willRecover ? 'success' : 'danger',
      title: willRecover ? 'Payment recovered' : 'Recovery attempt failed',
      message: willRecover
        ? `Recovered ${(recoveredAmount / 100).toLocaleString('en-IN')} from payment ${revenueCase.transactionId.slice(-6)}`
        : `Could not recover payment ${revenueCase.transactionId.slice(-6)} — the attempt did not convert.`,
      entityType: 'RevenueCase',
      entityId: revenueCase.id,
    });

    // ── Log production training data for continuous retraining ────────────────
    // After each verified outcome, record the features + label so the model
    // can be retrained on real production data.
    try {
      const diagnosis = (revenueCase.diagnosis ?? {}) as Record<string, unknown>;
      const category = String(diagnosis.primaryCategory || 'unknown');
      const tx = await prisma.transaction.findUnique({ where: { id: revenueCase.transactionId } });
      const occurredAt = tx?.occurredAt ? new Date(tx.occurredAt) : new Date();
      const hoursSince = Math.max(0, (Date.now() - occurredAt.getTime()) / 3600000);

      const trainingFeatures: any = {
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

      const actionType = action.actionType || 'unknown';
      await logTrainingData(trainingFeatures, willRecover, actionType);
    } catch {
      // Training data logging must never block outcome verification
    }

    // ── Periodic retrain trigger ──────────────────────────────────────────────
    // After every 25 verified outcomes, optionally trigger a background retrain
    // check. OFF by default so the demo/evidence pipeline stays fully
    // reproducible against the pinned committed artifact — set RP_AUTO_RETRAIN=1
    // to enable continuous self-improving retrains in a production deployment.
    if (process.env.RP_AUTO_RETRAIN === '1') {
      const g = globalThis as unknown as { __rpOutcomeCounter?: number };
      g.__rpOutcomeCounter = (g.__rpOutcomeCounter ?? 0) + 1;
      if (g.__rpOutcomeCounter % 25 === 0) {
        triggerRetrain().catch(() => {});
      }
    }

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
  
  return {
    success: true,
    result: { caseId, retryInMs: backoffMs },
  };
}

/**
 * Consume due RetrySchedule rows: for each case whose nextRetryAt has passed
 * and status is still "scheduled", create a fresh recovery evaluation job
 * (evaluating with the updated attempt count).
 *
 * Called periodically by the pg-boss startup interval (every 5 minutes).
 */
export async function consumeRetrySchedules(): Promise<{ checked: number; dispatched: number }> {
  const now = new Date();
  const due = await prisma.retrySchedule.findMany({
    where: { status: 'scheduled', nextRetryAt: { lte: now } },
    take: 50,
  });

  let dispatched = 0;
  for (const schedule of due) {
    if (schedule.currentRetry >= schedule.maxRetries) {
      // Exhausted — mark as done and stop the case
      await prisma.retrySchedule.update({
        where: { id: schedule.id },
        data: { status: 'exhausted' },
      });
      await prisma.revenueCase.updateMany({
        where: { id: schedule.caseId, status: { in: ['FAILED', 'OUTCOME_PENDING'] } },
        data: { status: 'STOPPED', stoppedReason: 'retry_exhausted' },
      });
      continue;
    }

    // Mark as executing so duplicate consumers skip it
    const claimed = await prisma.retrySchedule.updateMany({
      where: { id: schedule.id, status: 'scheduled' },
      data: { status: 'executing' },
    });
    if (claimed.count === 0) continue;

    // Re-evaluate the case — the pipeline will create a new action if the
    // model and policy still recommend one.
    setImmediate(() => {
      void processJob({} as Boss, JobType.EVALUATE_RECOVERY, {
        caseId: schedule.caseId,
        groundTruthSeed: Date.now(),
      })
        .then((r) => {
          if (r.success) {
            // Evaluation completed (an action was created, or the case was
            // intentionally stopped). The schedule has served its purpose.
            prisma.retrySchedule.update({
              where: { id: schedule.id },
              data: { status: 'completed' },
            }).catch(() => {});
            return;
          }
          // Evaluation FAILED loudly (e.g. ML service unreachable) — this is a
          // TRANSIENT, RECOVERABLE failure, not a terminal outcome. Re-arm the
          // schedule so the retry is attempted again later instead of being
          // silently dropped. Respect maxRetries: each re-arm increments
          // currentRetry and backs off exponentially.
          const attempt = schedule.currentRetry + 1;
          const backoffHours = Math.min(24, 1 * Math.pow(2, attempt - 1));
          const exhausted = attempt >= schedule.maxRetries;
          prisma.retrySchedule.update({
            where: { id: schedule.id },
            data: {
              status: exhausted ? 'exhausted' : 'scheduled',
              currentRetry: attempt,
              nextRetryAt: new Date(Date.now() + backoffHours * 3600_000),
            },
          }).catch(() => {});
          if (exhausted) {
            prisma.revenueCase.updateMany({
              where: { id: schedule.caseId, status: { in: ['FAILED', 'OUTCOME_PENDING'] } },
              data: { status: 'STOPPED', stoppedReason: 'retry_exhausted' },
            }).catch(() => {});
          } else {
            console.error(
              `retry evaluate-recovery ${schedule.caseId} returned failure; re-armed for retry in ${backoffHours}h`
            );
          }
        })
        .catch((err) => {
          // An exception while evaluating — reset to scheduled (with backoff)
          // so it can be retried, mirroring the recoverable-failure path.
          console.error(`retry evaluate-recovery ${schedule.caseId} threw:`, err);
          const attempt = schedule.currentRetry + 1;
          const backoffHours = Math.min(24, 1 * Math.pow(2, attempt - 1));
          const exhausted = attempt >= schedule.maxRetries;
          prisma.retrySchedule.update({
            where: { id: schedule.id },
            data: {
              status: exhausted ? 'exhausted' : 'scheduled',
              currentRetry: attempt,
              nextRetryAt: new Date(Date.now() + backoffHours * 3600_000),
            },
          }).catch(() => {});
        });
    });
    dispatched++;
  }

  return { checked: due.length, dispatched };
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

async function processCheckoutRecovery(payload: any): Promise<JobResult> {
  const { sessionId } = payload;

  try {
    const session = await prisma.checkoutSession.findFirst({
      where: sessionId ? { sessionId } : undefined,
    });
    if (!session) {
      return { success: false, error: 'Checkout session not found' };
    }

    if (session.status === 'expired' || (session.expiresAt && session.expiresAt < new Date())) {
      if (session.status !== 'expired') {
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'expired' },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: session.merchantId,
            actorType: 'system',
            actorId: 'checkout-recovery',
            action: 'checkout_session_expired',
            entityType: 'checkout_session',
            entityId: session.id,
            reason: 'Checkout session expired before recovery could be initiated',
            evidence: { expiresAt: session.expiresAt?.toISOString(), status: session.status } as any,
            createdAt: new Date(),
          },
        });
      }
      return { success: true, result: { sessionId: session.id, expired: true } };
    }

    if (session.status === 'recovered') {
      return { success: true, result: { sessionId: session.id, alreadyRecovered: true } };
    }

    await writeNotification(prisma, {
      merchantId: session.merchantId,
      type: 'checkout_recovery',
      severity: 'info',
      title: 'Checkout recovery in progress',
      message: `An abandoned checkout worth ${(session.amount / 100).toLocaleString('en-IN')} has a recovery queued via ${session.recoveryChannel ?? 'a configured channel'}.`,
      entityType: 'CheckoutSession',
      entityId: session.id,
    });

    return {
      success: true,
      result: {
        sessionId: session.id,
        status: session.status,
        amount: session.amount,
        customerEmail: session.customerEmail,
        customerPhone: session.customerPhone,
        recoveryChannel: session.recoveryChannel,
        incentiveType: session.incentiveType,
        incentiveValue: session.incentiveValue,
        abandonmentReason: session.abandonmentReason,
      },
    };
  } catch (error) {
    console.error('Error processing checkout recovery:', error);
    return { success: false, error: (error as Error).message };
  }
}

async function processReceivablesChase(payload: any): Promise<JobResult> {
  const { invoiceId, channel, message } = payload;

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    const now = new Date();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { lastChasedAt: now, chaseCount: { increment: 1 } },
    });

    await prisma.auditLog.create({
      data: {
        merchantId: invoice.merchantId,
        actorType: 'system',
        actorId: 'receivables-chaser',
        action: 'invoice_chased',
        entityType: 'invoice',
        entityId: invoice.id,
        reason: `Chase sent via ${channel || 'default'} for invoice ${invoice.invoiceNumber}`,
        evidence: {
          invoiceNumber: invoice.invoiceNumber,
          channel,
          message: message ?? null,
          amount: invoice.amount,
          overdueDays: invoice.overdueDays,
          chaseCount: invoice.chaseCount + 1,
        } as any,
        createdAt: now,
      },
    });

    await writeNotification(prisma, {
      merchantId: invoice.merchantId,
      type: 'invoice_chased',
      severity: 'info',
      title: 'Invoice reminder sent',
      message: `Chase sent to ${invoice.customerName ?? 'customer'} for invoice ${invoice.invoiceNumber} (${(invoice.amount / 100).toLocaleString('en-IN')}).`,
      entityType: 'Invoice',
      entityId: invoice.id,
    });

    return {
      success: true,
      result: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        channel,
        amount: invoice.amount,
        overdueDays: invoice.overdueDays,
      },
    };
  } catch (error) {
    console.error('Error processing receivables chase:', error);
    return { success: false, error: (error as Error).message };
  }
}

async function processPromiseCheck(payload: any): Promise<JobResult> {
  const { promiseId } = payload;

  try {
    const now = new Date();

    if (promiseId) {
      const promise = await prisma.promiseToPay.findUnique({ where: { id: promiseId } });
      if (!promise) {
        return { success: false, error: 'Promise not found' };
      }

      if (promise.status !== 'pending') {
        return { success: true, result: { checked: 0 } };
      }

      if (promise.promisedDate < now) {
        await prisma.promiseToPay.update({
          where: { id: promise.id },
          data: {
            status: 'broken',
            brokenAt: now,
            escalationLevel: { increment: 1 },
          },
        });
        await prisma.auditLog.create({
          data: {
            merchantId: promise.merchantId,
            actorType: 'system',
            actorId: 'promise-checker',
            action: 'promise_violated',
            entityType: 'promise_to_pay',
            entityId: promise.id,
            reason: `Promise broken: promised ${promise.promisedDate.toISOString()} for ${promise.promisedAmount} paise`,
            evidence: {
              promisedAmount: promise.promisedAmount,
              promisedDate: promise.promisedDate.toISOString(),
              channel: promise.channel,
              escalationLevel: promise.escalationLevel + 1,
            } as any,
            createdAt: now,
          },
        });
        await writeNotification(prisma, {
          merchantId: promise.merchantId,
          type: 'promise_broken',
          severity: 'warning',
          title: 'Promise to pay was broken',
          message: `A promise of ${(promise.promisedAmount / 100).toLocaleString('en-IN')} for ${promise.customerEmail ?? 'a customer'} has been marked broken — escalation recommended.`,
          entityType: 'PromiseToPay',
          entityId: promise.id,
        });
        return {
          success: true,
          result: { checked: 1, violated: 1, brokenId: promise.id },
        };
      }

      return { success: true, result: { checked: 1, violated: 0 } };
    }

    const overduePromises = await prisma.promiseToPay.findMany({
      where: {
        status: 'pending',
        promisedDate: { lt: now },
      },
    });

    const brokenIds: string[] = [];
    for (const p of overduePromises) {
      await prisma.promiseToPay.update({
        where: { id: p.id },
        data: {
          status: 'broken',
          brokenAt: now,
          escalationLevel: { increment: 1 },
        },
      });
      await prisma.auditLog.create({
        data: {
          merchantId: p.merchantId,
          actorType: 'system',
          actorId: 'promise-checker',
          action: 'promise_violated',
          entityType: 'promise_to_pay',
          entityId: p.id,
          reason: `Promise broken: promised ${p.promisedDate.toISOString()} for ${p.promisedAmount} paise`,
          evidence: {
            promisedAmount: p.promisedAmount,
            promisedDate: p.promisedDate.toISOString(),
            channel: p.channel,
            escalationLevel: p.escalationLevel + 1,
          } as any,
          createdAt: now,
        },
      });
      brokenIds.push(p.id);
    }

    return {
      success: true,
      result: { checked: overduePromises.length, violated: brokenIds.length, brokenIds },
    };
  } catch (error) {
    console.error('Error checking promises:', error);
    return { success: false, error: (error as Error).message };
  }
}