/**
 * Policy What-If Simulator.
 *
 * Read-only, non-executing preview of a candidate policy: replays the SAME
 * deterministic DecisionEngine used in production against real, persisted
 * case data (Prediction.featureSnapshot + probability, RevenueCase state)
 * for this merchant, once under the currently-saved policy and once under
 * the candidate policy the merchant is about to save. No RecoveryAction,
 * Outcome or provider call is ever created here — it is pure computation
 * over already-recorded predictions, so it is safe to run on every keystroke.
 *
 * This lets a merchant see, before saving, exactly how many cases would
 * flip action, how many would newly require human approval, and the
 * projected net-recovery delta across their real recent case mix — directly
 * answering "what happens to our stopping rules and escalation volume if I
 * relax this guardrail?" without touching a single live case.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { DecisionEngine, DEFAULT_MERCHANT_POLICY } from '@rp/policies';
import type { MerchantPolicy, DecisionResult } from '@rp/policies';
import type { RecoveryFeatures, BaselinePrediction } from '@rp/domain';
import { requireMerchantContext, requirePermission, apiErrorStatus } from '../../../../../lib/merchant-context';
import { checkRateLimit, rateLimitResponse } from '../../../../../lib/rate-limit';
import { csrfGuard } from '../../../../../lib/csrf';
import { sanitizePolicy } from '../sanitize';

const MAX_SAMPLE = 500;
const DEFAULT_SAMPLE = 200;

interface Aggregate {
  cases: number;
  byAction: Record<string, number>;
  requiresApproval: number;
  stoppedByPolicy: number;
  projectedNetRecovery: number; // sum of expectedNetRecovery for non-DO_NOTHING actions, paise
  projectedActions: number; // count of non-DO_NOTHING actions
}

function aggregate(decisions: DecisionResult[]): Aggregate {
  const agg: Aggregate = {
    cases: decisions.length,
    byAction: {},
    requiresApproval: 0,
    stoppedByPolicy: 0,
    projectedNetRecovery: 0,
    projectedActions: 0,
  };
  for (const d of decisions) {
    agg.byAction[d.decision.action] = (agg.byAction[d.decision.action] ?? 0) + 1;
    if (d.decision.requiresApproval) agg.requiresApproval += 1;
    if (d.policy.stoppingRuleTriggered) agg.stoppedByPolicy += 1;
    if (d.decision.action !== 'do_nothing') {
      agg.projectedNetRecovery += d.decision.expectedNetRecovery;
      agg.projectedActions += 1;
    }
  }
  return agg;
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  try {
    const ctx = await requireMerchantContext();
    requirePermission(ctx, 'policies:configure');
    const rl = checkRateLimit(req, 'policy-simulate', { limit: 30, windowMs: 60_000 }, ctx.merchantId);
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Expected a JSON policy object' }, { status: 400 });
    }

    const sampleSize = Math.min(
      MAX_SAMPLE,
      Math.max(1, Math.floor(Number(body.sampleSize) || DEFAULT_SAMPLE))
    );

    const { policy: candidateOverrides, errors } = sanitizePolicy(body.policy ?? body);
    if (errors.length) {
      return NextResponse.json({ error: 'Invalid policy', details: errors }, { status: 422 });
    }

    const merchant = await prisma.merchant.findUnique({ where: { id: ctx.merchantId } });
    const storedOverrides = ((merchant?.settings as Record<string, unknown>) ?? {}).recoveryPolicy as
      | Partial<MerchantPolicy>
      | undefined;
    const currentPolicy: MerchantPolicy = { ...DEFAULT_MERCHANT_POLICY, ...(storedOverrides ?? {}) };
    const candidatePolicy: MerchantPolicy = { ...currentPolicy, ...candidateOverrides };

    // Pull the most recent cases and their recorded predictions separately —
    // Prediction.caseId has no declared Prisma relation to RevenueCase — then
    // join in memory. This is real, persisted model output, not a re-run of
    // the ML service, so the simulator works even when the ML service is
    // offline and never drifts from what was actually scored at decision time.
    const cases = await prisma.revenueCase.findMany({
      where: { merchantId: ctx.merchantId },
      orderBy: { createdAt: 'desc' },
      take: sampleSize,
    });
    const predictions = await prisma.prediction.findMany({
      where: { caseId: { in: cases.map((c) => c.id) } },
    });
    const predictionByCaseId = new Map(predictions.map((p) => [p.caseId, p]));

    const engineCurrent = new DecisionEngine(currentPolicy);
    const engineCandidate = new DecisionEngine(candidatePolicy);

    const decisionsCurrent: DecisionResult[] = [];
    const decisionsCandidate: DecisionResult[] = [];
    const flips: { caseRef: string | null; from: string; to: string; amount: number }[] = [];

    for (const c of cases) {
      const prediction = predictionByCaseId.get(c.id);
      if (!prediction) continue;
      const features = prediction.featureSnapshot as unknown as RecoveryFeatures;
      const baseline: BaselinePrediction = {
        modelVersion: prediction.modelVersion,
        recoveryProbability: prediction.probability,
        expectedRecoveryValue: prediction.expectedValue,
        confidence: prediction.confidence ?? 0.5,
        featureWeights: {} as BaselinePrediction['featureWeights'],
        featureSnapshot: features,
      };
      const policyContext = {
        attemptCount: c.attemptCount,
        contactCount: c.attemptCount,
        caseAgeHours: Math.max(0, (Date.now() - new Date(c.createdAt).getTime()) / 3600000),
        lastAttemptAt: c.lastAttemptAt ?? null,
        customerDeclined:
          c.stoppedReason === 'customer_declined' || features.failureCategory === ('customer_cancellation' as unknown as RecoveryFeatures['failureCategory']),
        repeatedFailures: c.attemptCount >= 3,
      };

      const [dCurrent, dCandidate] = await Promise.all([
        engineCurrent.makeDecision(c.id, features, currentPolicy, baseline, policyContext),
        engineCandidate.makeDecision(c.id, features, candidatePolicy, baseline, policyContext),
      ]);
      decisionsCurrent.push(dCurrent);
      decisionsCandidate.push(dCandidate);

      if (dCurrent.decision.action !== dCandidate.decision.action) {
        flips.push({
          caseRef: c.ref,
          from: dCurrent.decision.action,
          to: dCandidate.decision.action,
          amount: c.amountAtRisk,
        });
      }
    }

    const current = aggregate(decisionsCurrent);
    const candidate = aggregate(decisionsCandidate);

    return NextResponse.json({
      sampled: cases.length,
      evaluated: decisionsCurrent.length,
      current,
      candidate,
      delta: {
        projectedNetRecovery: candidate.projectedNetRecovery - current.projectedNetRecovery,
        requiresApproval: candidate.requiresApproval - current.requiresApproval,
        stoppedByPolicy: candidate.stoppedByPolicy - current.stoppedByPolicy,
        projectedActions: candidate.projectedActions - current.projectedActions,
      },
      flippedCases: flips.slice(0, 25),
      flippedCount: flips.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Failed to simulate policy' },
      { status: apiErrorStatus(e) }
    );
  }
}
