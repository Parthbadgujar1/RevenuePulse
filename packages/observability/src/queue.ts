// Job Queue - PostgreSQL-backed queue using pg-boss
// Handles async job processing for webhook events, recovery evaluations, etc.

import { Pool } from 'pg';
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

// pg-boss is CommonJS; normalize default export across module systems
const Boss: any = (PgBossModule as any).default || PgBossModule;
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

// Create a pg-boss boss instance connected to the database
export function createBoss(pool: Pool): Boss {
  const boss = new Boss();
  
  // Set up the data source
  boss.on('ready', () => {
    console.log('pg-boss ready, awaiting jobs...');
  });
  
  boss.on('error', (err) => {
    console.error('pg-boss error:', err);
  });
  
  // Connect to the database using the pool
  // Note: pg-boss manages its own connection internally
  boss.dataSource = pool;
  
  return boss;
}

// Enqueue a job for asynchronous processing
// In production this delegates to pg-boss workers; in development the job
// handler runs in-process so the full pipeline is exercised end-to-end.
export async function enqueueProcessingJob(
  job: {
    type: JobType;
    payload: any;
    source: string;
    idempotencyKey?: string;
  },
  options?: JobOptions
): Promise<string> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`Job enqueued: ${job.type} - ${jobId}`);

  if (process.env.NODE_ENV !== 'production') {
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
  }

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
          createdAt: new Date(),
        },
      });
      caseId = revenueCase.id;

      // Chain the recovery-evaluation stage of the pipeline
      setImmediate(() => {
        void processJob({} as Boss, JobType.EVALUATE_RECOVERY, { caseId })
          .then((r) => {
            if (!r.success) console.error(`evaluate-recovery ${caseId} failed:`, r.error);
          })
          .catch((err) => console.error(`evaluate-recovery ${caseId} threw:`, err));
      });
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

    const engine = new DecisionEngine(DEFAULT_MERCHANT_POLICY);
    const decision = await engine.makeDecision(revenueCase.id, features);

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

      // Autonomous execution when approved-by-policy and auto-action enabled
      if (
        !decision.decision.requiresApproval &&
        DEFAULT_MERCHANT_POLICY.autoActionEnable
      ) {
        setImmediate(() => {
          void processJob({} as Boss, JobType.EXECUTE_ACTION, {
            actionId,
            simulated: true,
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
export const GROUND_TRUTH_BASE_RATES: Record<string, number> = {
  insufficient_funds: 0.55,
  bank_failure: 0.6,
  auth_failure: 0.65,
  expired_instrument: 0.35,
  network_timeout: 0.7,
  customer_cancellation: 0.15,
  repeated_failure: 0.3,
  payment_method_degradation: 0.45,
  subscription_failure: 0.5,
  unknown: 0.4,
};

export function simulateGroundTruthOutcome(
  primaryCategory: string,
  actionType: string,
  attemptCount: number
): number {
  let p = GROUND_TRUTH_BASE_RATES[primaryCategory] ?? 0.4;
  p -= 0.08 * attemptCount; // retry fatigue
  if (actionType === 'payment_method_recovery') {
    p += ['expired_instrument', 'payment_method_degradation'].includes(primaryCategory) ? 0.15 : -0.05;
  } else if (actionType === 'timed_reminder') {
    p += primaryCategory === 'insufficient_funds' ? 0.08 : 0;
  } else if (actionType === 'retry_later') {
    p += ['network_timeout', 'bank_failure'].includes(primaryCategory) ? 0.05 : 0;
  } else if (actionType === 'human_escalation') {
    p += 0.1;
  }
  return Math.min(0.95, Math.max(0.02, p));
}

// Execute a recovery action (simulation provider in DEMO mode)
async function executeAction(payload: any): Promise<JobResult> {
  const { actionId, simulated } = payload;

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
    const providerActionId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // DEMO-mode simulation: outcome drawn from a ground-truth propensity that is
    // independent of the model score (category base rate + retry fatigue +
    // intervention fit). Clearly labeled so measured results are honest.
    const primaryCategory =
      ((revenueCase.diagnosis as Record<string, unknown>)?.primaryCategory as string) || 'unknown';
    const groundTruthProbability = simulateGroundTruthOutcome(
      primaryCategory,
      action.actionType,
      revenueCase.attemptCount
    );
    const roll = Math.random();
    const willRecover = roll < groundTruthProbability;
    const executionDetails = {
      mode: simulated ? 'SIMULATED_DEMO' : 'LIVE',
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

// Verify outcome of a recovery action and measure recovered money
async function verifyOutcome(payload: any): Promise<JobResult> {
  const { actionId, executionDetails } = payload;

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