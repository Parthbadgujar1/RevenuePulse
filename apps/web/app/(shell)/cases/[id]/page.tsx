// Case detail — plain-language view of a single failed payment
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';
import { inr, humanizeAction, statusTone, timeAgo, SOURCE_LABELS } from '../../../../lib/ui';
import { PageHeader } from '../../../../components/ui/states';
import {
  plainFailureExplanation,
  plainActionExplanation,
  plainOutcomeExplanation,
  suggestedAdminActions,
} from '../../../../lib/case-explain';
import ApproveButton from '../../../../components/approve-button';
import AdminActions from '../../../../components/admin-actions';
import VerifyOutcomeButton from '../../../../components/verify-outcome-button';
import RetryScheduleViewer from '../../../../components/retry-schedule-viewer';
import AiDecisionCard from '../../../../components/ai-decision-card';

export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, { label: string; icon: string }> = {
  failure_diagnosed: { label: 'Diagnosed the failure', icon: '🔍' },
  recovery_predicted: { label: 'AI estimated recovery chance', icon: '🧠' },
  recovery_decision_made: { label: 'AI chose next step', icon: '⚖️' },
  agent_orchestrated: { label: 'AI reasoned about recovery', icon: '🤖' },
  action_approved: { label: 'You approved the action', icon: '👤' },
  recovery_action_executed: { label: 'Recovery action ran', icon: '⚡' },
  recovery_outcome_verified: { label: 'Result confirmed', icon: '✅' },
  transaction_event_processed: { label: 'Payment failure recorded', icon: '📩' },
  admin_accept: { label: 'You accepted the result', icon: '✅' },
  admin_retry: { label: 'You requested a retry', icon: '🔄' },
  admin_mark_recovered: { label: 'You confirmed recovery', icon: '💰' },
  admin_mark_failed: { label: 'You confirmed it failed', icon: '❌' },
  refund_requested: { label: 'Refund requested', icon: '💸' },
  outcome_verification_timeout: { label: 'Provider did not respond in time', icon: '⏳' },
};

const MAX_ATTEMPTS = 3;

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    DETECTED: 'New',
    EVALUATED: 'Analyzed',
    ACTION_PENDING: 'Waiting for approval',
    RECOVERY_IN_PROGRESS: 'Recovery in progress',
    OUTCOME_PENDING: 'Waiting for bank result',
    RECOVERED: 'Recovered',
    FAILED: 'Not recovered',
    STOPPED: 'Closed',
  };
  return (
    <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${statusTone(status)}`}>
      {labels[status] ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireMerchantContext();

  const revenueCase = await prisma.revenueCase.findFirst({
    where: { id, merchantId: ctx.merchantId },
    include: { transaction: true },
  }).catch(() => null);

  if (!revenueCase) notFound();

  const [prediction, actions] = await Promise.all([
    prisma.prediction.findUnique({ where: { caseId: id } }),
    prisma.recoveryAction.findMany({ where: { caseId: id }, orderBy: { id: 'asc' as const } }),
  ]);
  const actionIds = actions.map((a) => a.id);
  const [outcomeRows, auditLogs, refunds, retrySchedules] = await Promise.all([
    prisma.outcome.findMany({
      where: { actionId: { in: actionIds } },
      orderBy: { createdAt: 'asc' as const },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'revenue_case', entityId: id },
          { entityType: 'recovery_action', entityId: { in: actionIds } },
          { entityType: 'transaction', entityId: revenueCase.transactionId },
        ],
      },
      orderBy: { createdAt: 'asc' as const },
    }),
    prisma.refund.findMany({
      where: { caseId: id },
      orderBy: { createdAt: 'desc' as const },
    }),
    prisma.retrySchedule.findMany({
      where: { caseId: id },
      orderBy: { nextRetryAt: 'asc' as const },
    }).catch(() => []),
  ]);

  const tx = (revenueCase as any).transaction;
  const diag = (revenueCase.diagnosis ?? {}) as Record<string, unknown>;
  const latestAction = actions[actions.length - 1] ?? null;
  const latestOutcome = outcomeRows[outcomeRows.length - 1] ?? null;
  const pendingApproval =
    latestAction && latestAction.approvalStatus === 'pending' && latestAction.executionStatus !== 'EXECUTED';

  // Plain-language content
  const whatHappened = plainFailureExplanation(diag, tx ? { paymentMethod: tx.paymentMethod } : null);
  const whatAiSuggests = prediction
    ? plainActionExplanation(
        latestAction?.actionType ?? null,
        prediction.probability,
        revenueCase.amountAtRisk,
        revenueCase.attemptCount,
        MAX_ATTEMPTS,
      )
    : null;
  const adminActions = suggestedAdminActions(
    revenueCase.status,
    latestAction?.actionType ?? null,
    prediction?.probability ?? 0,
    revenueCase.attemptCount,
    MAX_ATTEMPTS,
  );

  // The agent-orchestrated audit entry carries the AI's reasoning: the LLM
  // provider/model (when a real LLM responded), the proposed action, and the
  // rationale. The recovery action's policy snapshot carries the guardrail
  // verdict. Both are rendered in the AI Recovery Decision card.
  const agentLog = auditLogs.find((l) => l.action === 'agent_orchestrated') ?? null;
  const agentEvidence = (agentLog?.evidence ?? {}) as Record<string, unknown>;
  const llmInfo = (agentEvidence.llm ?? null) as
    | { provider: string; model: string; succeeded: boolean }
    | null;
  const agentDiagnosis = (agentEvidence.diagnosis ?? null) as
    | { category: string; confidence: number; evidence?: string[] }
    | null;
  // DO_NOTHING cases never create a recovery action, so the guardrail verdict
  // comes from the decision engine's audit entry (policyResult) instead.
  const decisionLog = auditLogs.find((l) => l.action === 'recovery_decision_made') ?? null;
  const decisionPolicy = ((decisionLog as any)?.policyResult ?? null) as
    | { allowed?: boolean; violations?: string[]; stoppingRuleTriggered?: boolean }
    | null;
  const actionSnapshot = (latestAction?.policySnapshot ?? null) as
    | {
        probability?: number;
        rationale?: string;
        violations?: string[];
        stoppingRuleTriggered?: boolean;
        blockedAlternatives?: Array<{ action: string; reason: string }>;
      }
    | null;
  const violations =
    actionSnapshot?.violations ?? decisionPolicy?.violations ?? [];
  const aiCardActionSnapshot = actionSnapshot ?? {
    rationale: decisionLog?.reason ?? '',
    violations,
    stoppingRuleTriggered: !!decisionPolicy?.stoppingRuleTriggered,
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/cases" className="inline-flex items-center gap-1.5 text-sm text-ink-2 transition hover:text-accent-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        All cases
      </Link>

      {/* Header — plain language */}
      <div className="mt-3">
        <PageHeader
          title={
            <>
              {inr(revenueCase.amountAtRisk)} payment from {tx?.customerName || 'customer'}
            </>
          }
          subtitle={
            <>
              Case {revenueCase.ref || 'new'} · {tx?.paymentMethod ? `paid via ${tx.paymentMethod}` : 'payment'}{' '}
              {tx?.occurredAt ? `${timeAgo(tx.occurredAt)}` : ''}
            </>
          }
          actions={<StatusBadge status={revenueCase.status} />}
        />
      </div>

      {/* What happened — plain English */}
      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">What happened</p>
        <p className="mt-1 text-sm text-slate-200">{whatHappened}</p>
      </div>

      {/* Outcome banner — simplified */}
      {latestOutcome && (
        <div
          className={`mt-3 rounded-lg border p-4 ${
            latestOutcome.result === 'RECOVERED' || latestOutcome.result === 'ADMIN_CONFIRMED_RECOVERY'
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-slate-700 bg-slate-900'
          }`}
        >
          {latestOutcome.result === 'RECOVERED' || latestOutcome.result === 'ADMIN_CONFIRMED_RECOVERY' ? (
            <>
              <p className="font-semibold text-emerald-300">
                {plainOutcomeExplanation(
                  latestOutcome.result,
                  latestOutcome.recoveredAmount,
                  latestOutcome.measuredCost,
                  latestOutcome.notes,
                )}
              </p>
              {latestOutcome.verifiedAt && (
                <p className="mt-0.5 text-xs text-emerald-400">
                  Confirmed {timeAgo(latestOutcome.verifiedAt)}
                  {latestOutcome.verificationRef ? ` · ref ${latestOutcome.verificationRef}` : ''}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-300">
                {plainOutcomeExplanation(
                  'NOT_RECOVERED',
                  0,
                  0,
                  latestOutcome.notes,
                )}
              </p>
              {adminActions.length > 0 && (
                <div className="mt-3">
                  <AdminActions caseId={id} actions={adminActions} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Outcomes banner for FAILED/STOPPED without explicit outcome */}
      {['FAILED', 'STOPPED'].includes(revenueCase.status) && !latestOutcome && (
        <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="text-sm text-slate-300">
            {revenueCase.status === 'FAILED'
              ? 'This payment was not recovered. The system tried but the bank or provider did not complete the transfer.'
              : `This case was closed${revenueCase.stoppedReason ? ` — ${revenueCase.stoppedReason.replace(/_/g, ' ')}` : ''}.`}
          </p>
          {adminActions.length > 0 && (
            <div className="mt-3">
              <AdminActions caseId={id} actions={adminActions} />
            </div>
          )}
        </div>
      )}

      {/* OUTCOME_PENDING — waiting for bank */}
      {revenueCase.status === 'OUTCOME_PENDING' && !latestOutcome && (
        <div className="mt-3 rounded-lg border border-orange-300 bg-orange-50 p-4">
          <p className="text-sm font-semibold text-orange-900">
            Waiting for the bank to confirm the result
          </p>
          <p className="mt-0.5 text-sm text-orange-800">
            A recovery action was sent to Razorpay. We're waiting for the bank to say whether
            the payment went through. This usually takes a few hours but can take up to 3 days.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <VerifyOutcomeButton />
          </div>
          {adminActions.length > 0 && (
            <div className="mt-3">
              <AdminActions caseId={id} actions={adminActions} />
            </div>
          )}
        </div>
      )}

      {/* Pending approval */}
      {pendingApproval && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-yellow-900">
            This action needs your approval before it can run.
          </p>
          <p className="mt-0.5 text-sm text-amber-300">
            The AI has proposed a recovery plan. Review the details below and approve when ready.
          </p>
          <div className="mt-2">
            <ApproveButton caseId={id} />
          </div>
        </div>
      )}

      {/* Refund status */}
      {refunds.length > 0 && (
        <div className="mt-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
          <p className="text-sm font-semibold text-blue-900">Refund Status</p>
          {refunds.map((refund) => (
            <div key={refund.id} className="mt-2 flex items-center gap-3 text-sm text-blue-300">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                refund.status === 'processed'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : refund.status === 'initiated'
                    ? 'bg-blue-100 text-blue-300'
                    : refund.status === 'failed'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-amber-500/20 text-amber-300'
              }`}>
                {refund.status}
              </span>
              <span>{inr(refund.amount)} refund</span>
              {refund.providerRefundId && (
                <span className="font-mono text-xs text-blue-600">{refund.providerRefundId}</span>
              )}
              <span className="text-xs text-blue-500">
                {refund.status === 'pending' && 'Waiting to be processed'}
                {refund.status === 'initiated' && 'Refund sent to payment provider'}
                {refund.status === 'processed' && `Completed ${timeAgo(refund.completedAt ?? refund.createdAt)}`}
                {refund.status === 'failed' && `Failed — ${refund.failureReason ?? 'unknown reason'}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Left column: AI insight */}
        <section className="lg:col-span-3">
          {/* AI Recovery Decision — the full reasoning chain */}
          <AiDecisionCard
            diag={diag}
            prediction={
              prediction
                ? {
                    probability: prediction.probability,
                    confidence: prediction.confidence,
                    modelVersion: prediction.modelVersion,
                  }
                : null
            }
            agentEntry={{
              reason: agentLog?.reason ?? '',
              diagnosis: agentDiagnosis ?? undefined,
              proposedAction: (agentEvidence.proposedAction as string) ?? undefined,
              finalDecision: (agentEvidence.finalDecision as string) ?? undefined,
              policyAllowed: (agentEvidence.policyAllowed as boolean) ?? undefined,
              violations,
              llm: llmInfo ?? undefined,
            }}
            actionSnapshot={aiCardActionSnapshot}
          />

          {/* AI suggestion — plain language */}
          {whatAiSuggests && (
            <div className="mb-3 mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">AI recommendation</p>
              <p className="mt-1 text-sm text-emerald-900">{whatAiSuggests}</p>
              <p className="mt-1 text-xs text-emerald-400">
                Based on model {prediction?.modelVersion ?? 'v3'} · scored{' '}
                {new Date(actions.find((a) => a.actionType)?.createdAt ?? revenueCase.createdAt).toLocaleTimeString()}
              </p>
            </div>
          )}

          {/* Simple stats */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Recovery chance"
              value={prediction ? `${(prediction.probability * 100).toFixed(0)}%` : '—'}
              hint="AI confidence"
            />
            <Stat
              label="Recommended next step"
              value={latestAction ? humanizeAction(latestAction.actionType) : 'None'}
              hint={
                latestAction?.expectedNetRecovery
                  ? `would recover ${inr(latestAction.expectedNetRecovery)}`
                  : undefined
              }
            />
            <Stat
              label="Tries so far"
              value={`${revenueCase.attemptCount} of ${MAX_ATTEMPTS}`}
              hint={revenueCase.lastAttemptAt ? `last try ${timeAgo(revenueCase.lastAttemptAt)}` : undefined}
            />
            <Stat
              label="Recovery cost"
              value={latestAction?.expectedCost ? inr(latestAction.expectedCost) : 'Free'}
              hint={latestAction?.expectedCost ? 'estimated' : 'no cost for this action'}
            />
          </div>

          {/* AI alternatives considered — simplified */}
          {(() => {
            const snapshot = (latestAction?.policySnapshot ?? {}) as Record<string, unknown>;
            const blocked = (snapshot.blockedAlternatives as Array<{ action: string; reason: string }>) || [];
            if (blocked.length === 0) return null;
            return (
              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Other options the AI considered
                </p>
                <ul className="mt-2 space-y-1.5">
                  {blocked.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-400">
                      <span className="mt-0.5 text-gray-300">•</span>
                      <span>
                        <span className="font-medium">{humanizeAction(b.action)}</span>{' '}
                        — {b.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* Transaction details — simplified */}
          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment details</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-slate-400">Amount</dt>
              <dd className="text-slate-200">{inr(tx?.amount ?? revenueCase.amountAtRisk)}</dd>
              <dt className="text-slate-400">Method</dt>
              <dd className="capitalize text-slate-200">{tx?.paymentMethod ?? '—'}</dd>
              {tx?.providerTransactionId && (
                <>
                  <dt className="text-slate-400">Razorpay ID</dt>
                  <dd className="truncate font-mono text-xs text-slate-400">{tx.providerTransactionId}</dd>
                </>
              )}
              {tx?.customerName && (
                <>
                  <dt className="text-slate-400">Customer</dt>
                  <dd className="text-slate-200">{tx.customerName}</dd>
                </>
              )}
              {tx?.customerEmail && (
                <>
                  <dt className="text-slate-400">Email</dt>
                  <dd className="truncate text-slate-200">{tx.customerEmail}</dd>
                </>
              )}
              <dt className="text-slate-400">Source</dt>
              <dd className="text-slate-200">
                {SOURCE_LABELS[String((tx?.paymentMethodDetails as any)?.source ?? 'webhook')] ??
                  '🔵 Razorpay Webhook'}
              </dd>
            </dl>
          </div>
        </section>

        {/* Right column: timeline */}
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-lg font-medium text-slate-100">What we did</h2>
          <ol className="relative space-y-4 border-l-2 border-slate-800 pl-5">
            {auditLogs.length === 0 && (
              <li className="text-sm text-slate-400">No actions recorded yet.</li>
            )}
            {auditLogs.map((log) => {
              const meta = ACTION_LABELS[log.action] || {
                label: log.action.replace(/_/g, ' '),
                icon: '•',
              };
              const llmBadge =
                log.action === 'agent_orchestrated'
                  ? (() => {
                      const ev = (log.evidence ?? {}) as { llm?: { provider?: string; succeeded?: boolean } };
                      const llm = ev.llm;
                      if (llm?.succeeded && llm.provider) {
                        return (
                          <span className="mt-1 inline-block rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-300">
                            {llm.provider === 'gemini' ? 'Gemini' : llm.provider === 'groq' ? 'Groq' : llm.provider}
                          </span>
                        );
                      }
                      return (
                        <span className="mt-1 inline-block rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                          deterministic
                        </span>
                      );
                    })()
                  : null;
              return (
                <li key={log.id} className="relative">
                  <span className="absolute -left-[27px] flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-xs ring-2 ring-emerald-500/30">
                    {meta.icon}
                  </span>
                  <p className="text-sm font-medium text-slate-100">{meta.label}</p>
                  <p className="text-xs text-slate-400">{log.reason}</p>
                  {llmBadge}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {new Date(log.createdAt).toLocaleTimeString()} ·{' '}
                    {log.actorType === 'system' || log.actorType === 'agent' ? 'AI' : log.actorId}
                  </p>
                </li>
              );
            })}
          </ol>

          {retrySchedules.length > 0 && (
            <div className="mt-6">
              <RetryScheduleViewer caseId={id} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{value}</p>
      {hint && <p className="truncate text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
