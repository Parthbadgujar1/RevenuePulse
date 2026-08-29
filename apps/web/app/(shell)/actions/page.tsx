// Recovery Actions - what the agent decided and executed
import Link from 'next/link';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { inr, humanizeAction, categoryLabel, timeAgo, statusTone } from '../../../lib/ui';
import { Card } from '../../../components/ui/card';
import { PageHeader, EmptyState } from '../../../components/ui/states';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function ActionsPage() {
  let rows: Array<{
    action: Awaited<ReturnType<typeof prisma.recoveryAction.findFirst>> & object;
    caseRef: string | null;
    caseStatus: string;
    amount: number;
    category: string;
    outcome: { result: string; recoveredAmount: number; measuredCost: number } | null;
  }> = [];
  let ok = true;
  try {
    const { merchantId } = await requireMerchantContext();
    // Scope via the merchant's cases (RecoveryAction has no Prisma relation).
    const caseIds = (
      await prisma.revenueCase.findMany({ where: { merchantId }, select: { id: true } })
    ).map((c) => c.id);
    const actions = await prisma.recoveryAction.findMany({
      where: { caseId: { in: caseIds } },
      orderBy: { createdAt: 'desc' as const },
      take: 100,
    });
    const cases = await prisma.revenueCase.findMany({
      where: { id: { in: actions.map((a) => a.caseId) } },
      include: { transaction: true },
    });
    const outcomes = await prisma.outcome.findMany({
      where: { actionId: { in: actions.map((a) => a.id) } },
    });
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const outcomeByAction = new Map(outcomes.map((o) => [o.actionId, o]));
    rows = actions.map((a) => {
      const c = caseById.get(a.caseId) as any;
      const diag = (c?.diagnosis ?? {}) as Record<string, unknown>;
      return {
        action: a,
        caseRef: c?.ref || c?.id?.slice(-6) || '—',
        caseStatus: c?.status || '—',
        amount: c?.amountAtRisk ?? 0,
        category: String(diag.primaryCategory || 'unknown'),
        outcome: outcomeByAction.get(a.id)
          ? {
              result: outcomeByAction.get(a.id)!.result,
              recoveredAmount: outcomeByAction.get(a.id)!.recoveredAmount,
              measuredCost: outcomeByAction.get(a.id)!.measuredCost,
            }
          : null,
      };
    });
  } catch {
    ok = false;
  }

  function Badge({ kind, children }: { kind: 'warning' | 'success' | 'accent' | 'muted'; children: ReactNode }) {
    const tones = {
      warning: 'border-warning/30 bg-warning/10 text-warning-ink',
      success: 'border-success/30 bg-success/10 text-success-ink',
      accent: 'border-accent/30 bg-accent/10 text-accent-ink',
      muted: 'border-edge bg-surface-2 text-ink-3',
    };
    return (
      <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium ${tones[kind]}`}>
        {children}
      </span>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Recovery Actions"
        subtitle="Every intervention the AI agent decided, its policy status, and the verified outcome."
      />

      {!ok && (
        <div className="mb-4 rounded-lg border border-warning-pill bg-warning-pill/[0.08] px-4 py-3 text-sm text-warning-ink">
          Database unreachable. Showing nothing until the store comes back.
        </div>
      )}

      {ok && rows.length === 0 && (
        <EmptyState
          title="No actions yet"
          message={
            <>
              Run the{' '}
              <Link href="/demo-lab" className="font-medium text-accent hover:underline">
                Demo Lab
              </Link>{' '}
              to generate recovery actions.
            </>
          }
        />
      )}

      {ok && rows.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-edge bg-surface-2 text-xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-5 py-3">Case</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Failure</th>
                <th className="px-5 py-3">AI Decision</th>
                <th className="px-5 py-3">Approval</th>
                <th className="px-5 py-3">Execution</th>
                <th className="px-5 py-3">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge bg-surface">
              {rows.map(({ action, caseRef, amount, category, outcome }) => (
                <tr key={action.id} className="transition hover:bg-surface-2">
                  <td className="px-5 py-3">
                    <Link href={`/cases/${(action as any).caseId}`} className="font-mono font-medium text-accent hover:underline">
                      {caseRef}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-medium text-ink">{inr(amount)}</td>
                  <td className="px-5 py-3 capitalize text-ink-2">{categoryLabel(category)}</td>
                  <td className="px-5 py-3 text-ink">
                    {humanizeAction(action.actionType)}
                    <div className="text-xs text-ink-3">exp. net {inr(action.expectedNetRecovery)}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge
                      kind={
                        action.approvalStatus === 'pending'
                          ? 'warning'
                          : action.approvalStatus === 'approved'
                            ? 'accent'
                            : 'muted'
                      }
                    >
                      {action.approvalStatus.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${statusTone(
                      action.executionStatus === 'EXECUTED' ? 'RECOVERY_IN_PROGRESS' : 'EVALUATED'
                    )}`}>
                      {(action as any).executionStatus}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {outcome ? (
                      outcome.result === 'RECOVERED' || outcome.result === 'ADMIN_CONFIRMED_RECOVERY' ? (
                        <Badge kind="success">Recovered {inr(outcome.recoveredAmount)}</Badge>
                      ) : (
                        <span className="text-ink-2">Not recovered</span>
                      )
                    ) : (
                      <span className="text-ink-3">{timeAgo((action as any).createdAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
