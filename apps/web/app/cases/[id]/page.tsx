// Case detail - the AI investigation of a single failed payment
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@rp/database';
import { inr, humanizeAction, categoryLabel, statusTone, timeAgo } from '../../../lib/ui';
import ApproveButton from '../../../components/approve-button';

export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, { label: string; icon: string }> = {
  failure_diagnosed: { label: 'Failure diagnosed', icon: '🔍' },
  recovery_predicted: { label: 'ML model scored', icon: '🧠' },
  recovery_decision_made: { label: 'Decision engine selected', icon: '⚖️' },
  action_approved: { label: 'Human approval granted', icon: '👤' },
  recovery_action_executed: { label: 'Action executed', icon: '⚡' },
  recovery_outcome_verified: { label: 'Outcome verified', icon: '✅' },
  transaction_event_processed: { label: 'Webhook received', icon: '📩' },
};

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const revenueCase = await prisma.revenueCase.findUnique({
    where: { id },
    include: { transaction: true },
  }).catch(() => null);

  if (!revenueCase) notFound();

  const [prediction, actions] = await Promise.all([
    prisma.prediction.findUnique({ where: { caseId: id } }),
    prisma.recoveryAction.findMany({ where: { caseId: id }, orderBy: { id: 'asc' as const } }),
  ]);
  const actionIds = actions.map((a) => a.id);
  const [outcomeRows, auditLogs] = await Promise.all([
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
  ]);

  const tx = (revenueCase as any).transaction;
  const diag = (revenueCase.diagnosis ?? {}) as Record<string, unknown>;
  const latestAction = actions[actions.length - 1] ?? null;
  const snapshot = (latestAction?.policySnapshot ?? {}) as Record<string, unknown>;
  const violations = (snapshot.violations as string[]) || [];
  const blocked = (snapshot.blockedAlternatives as Array<{ action: string; reason: string }>) || [];
  const latestOutcome = outcomeRows[outcomeRows.length - 1] ?? null;
  const pendingApproval =
    latestAction && latestAction.approvalStatus === 'pending' && latestAction.executionStatus !== 'EXECUTED';

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <Link href="/cases" className="text-sm text-emerald-600 hover:underline">
        ← All cases
      </Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            <span className="font-mono">{revenueCase.ref || 'CASE'}</span>
            {' · '}
            {inr(revenueCase.amountAtRisk)} at risk
          </h1>
          <p className="mt-1 text-sm capitalize text-gray-500">
            {categoryLabel(String(diag.primaryCategory || 'unknown'))}
            {diag.failureCode ? (
              <span className="ml-2 font-mono text-xs text-gray-400">
                code {String(diag.failureCode)}
              </span>
            ) : null}
            {' · '}priority score {revenueCase.priority}
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${statusTone(revenueCase.status)}`}>
          {revenueCase.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Outcome banner */}
      {latestOutcome && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            latestOutcome.result === 'RECOVERED'
              ? 'border-green-300 bg-green-50'
              : 'border-gray-300 bg-gray-50'
          }`}
        >
          {latestOutcome.result === 'RECOVERED' ? (
            <>
              <p className="font-semibold text-green-800">✓ Recovered — {inr(latestOutcome.recoveredAmount)}</p>
              <p className="mt-0.5 text-sm text-green-700">
                Action cost {inr(latestOutcome.measuredCost)} · Net recovered{' '}
                {inr(latestOutcome.recoveredAmount - latestOutcome.measuredCost)}
                {latestOutcome.verifiedAt ? ` · verified ${timeAgo(latestOutcome.verifiedAt)}` : ''}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-700">
              Recovery attempt did not succeed{latestOutcome.notes ? ` — ${latestOutcome.notes}` : ''}. The
              policy engine may schedule another bounded attempt.
            </p>
          )}
        </div>
      )}

      {pendingApproval && (
        <div className="mt-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4">
          <p className="text-sm font-semibold text-yellow-900">
            This action needs human approval before it can execute.
          </p>
          <div className="mt-2">
            <ApproveButton caseId={id} />
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* AI investigation panel */}
        <section className="lg:col-span-3">
          <h2 className="mb-3 text-lg font-medium text-gray-900">AI Investigation</h2>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="AI Recovery Probability"
              value={prediction ? `${(prediction.probability * 100).toFixed(0)}%` : '—'}
              hint={prediction?.modelVersion}
            />
            <Stat
              label="Recommended Action"
              value={humanizeAction(latestAction?.actionType)}
              hint={
                latestAction
                  ? `expected net ${inr(latestAction.expectedNetRecovery)}`
                  : undefined
              }
            />
            <Stat
              label="Expected Cost"
              value={latestAction ? inr(latestAction.expectedCost) : '—'}
            />
            <Stat
              label="Attempts"
              value={`${revenueCase.attemptCount} / 3`}
              hint={revenueCase.lastAttemptAt ? `last ${timeAgo(revenueCase.lastAttemptAt)}` : undefined}
            />
          </div>

          {/* Policy status */}
          <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-gray-900">Policy Status</p>
            {!latestAction ? (
              <p className="mt-1 text-sm text-gray-600">
                No intervention recommended — the decision engine found no positive expected value
                or a stopping rule applied.
                {revenueCase.stoppedReason ? ` (${revenueCase.stoppedReason})` : ''}
              </p>
            ) : violations.length === 0 ? (
              <p className="mt-1 text-sm text-green-700">
                ✓ Allowed — within retry limits, spend ceilings and approval thresholds.
              </p>
            ) : (
              <ul className="mt-1 list-inside list-disc text-sm text-yellow-700">
                {violations.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
            {blocked.length > 0 && (
              <div className="mt-2 border-t border-gray-100 pt-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  Alternatives considered & blocked
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
                  {blocked.map((b, i) => (
                    <li key={i}>
                      <span className="font-medium capitalize">{humanizeAction(b.action)}</span> —{' '}
                      {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Decision explanation */}
          {snapshot.rationale ? (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold text-gray-900">Why this decision?</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-gray-600">
                <li>{String(snapshot.rationale)}</li>
                {prediction && (
                  <li>
                    Model score {(prediction.probability * 100).toFixed(0)}% × amount{' '}
                    {inr(revenueCase.amountAtRisk)} minus intervention cost exceeds the merchant's
                    minimum expected net recovery.
                  </li>
                )}
                {tx?.paymentMethod && (
                  <li>
                    Failed via {categoryLabel(tx.paymentMethod)}
                    {tx.failureMessage ? `: "${tx.failureMessage}"` : ''}
                    .
                  </li>
                )}
                <li>Current retry limit not reached ({revenueCase.attemptCount}/3 attempts used).</li>
              </ul>
            </div>
          ) : null}

          {/* Transaction facts */}
          <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-gray-900">Transaction</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-gray-500">Provider ref</dt>
              <dd className="truncate font-mono text-xs text-gray-800">{tx?.providerTransactionId}</dd>
              <dt className="text-gray-500">Amount</dt>
              <dd className="text-gray-800">{inr(tx?.amount ?? revenueCase.amountAtRisk)}</dd>
              <dt className="text-gray-500">Method</dt>
              <dd className="capitalize text-gray-800">{tx?.paymentMethod ?? '—'}</dd>
              <dt className="text-gray-500">Occurred</dt>
              <dd className="text-gray-800">{tx?.occurredAt ? timeAgo(tx.occurredAt) : '—'}</dd>
            </dl>
          </div>
        </section>

        {/* Timeline */}
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-lg font-medium text-gray-900">Audit Timeline</h2>
          <ol className="relative space-y-4 border-l-2 border-gray-200 pl-5">
            {auditLogs.length === 0 && (
              <li className="text-sm text-gray-500">No audit entries recorded.</li>
            )}
            {auditLogs.map((log) => {
              const meta = ACTION_LABELS[log.action] || {
                label: log.action.replace(/_/g, ' '),
                icon: '•',
              };
              return (
                <li key={log.id} className="relative">
                  <span className="absolute -left-[27px] flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs ring-2 ring-emerald-200">
                    {meta.icon}
                  </span>
                  <p className="text-sm font-medium text-gray-900">{meta.label}</p>
                  <p className="text-xs text-gray-600">{log.reason}</p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {new Date(log.createdAt).toLocaleTimeString()} · {log.actorType}/{log.actorId}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-lg font-semibold capitalize text-gray-900">{value}</p>
      {hint && <p className="truncate text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
