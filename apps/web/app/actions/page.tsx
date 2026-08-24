// Recovery Actions - what the agent decided and executed
import Link from 'next/link';
import { prisma } from '@rp/database';
import { inr, humanizeAction, categoryLabel, timeAgo, statusTone } from '../../lib/ui';

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
    const actions = await prisma.recoveryAction.findMany({ orderBy: { createdAt: 'desc' as const }, take: 100 });
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

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Recovery Actions</h1>
      <p className="mt-1 text-sm text-gray-500">
        Every intervention the AI agent decided, its policy status, and the verified outcome.
      </p>

      {!ok && (
        <div className="mt-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800">
          Database unreachable.
        </div>
      )}

      {ok && rows.length === 0 && (
        <p className="mt-6 rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
          No actions yet — run the{' '}
          <Link href="/demo-lab" className="font-medium text-emerald-600 hover:underline">
            Demo Lab
          </Link>
          .
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Case</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Failure</th>
                <th className="px-4 py-3">AI Decision</th>
                <th className="px-4 py-3">Approval</th>
                <th className="px-4 py-3">Execution</th>
                <th className="px-4 py-3">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(({ action, caseRef, amount, category, outcome }) => (
                <tr key={action.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/cases/${(action as any).caseId}`} className="font-mono font-medium text-emerald-700 hover:underline">
                      {caseRef}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{inr(amount)}</td>
                  <td className="px-4 py-3 capitalize text-gray-600">{categoryLabel(category)}</td>
                  <td className="px-4 py-3 text-gray-800">
                    {humanizeAction(action.actionType)}
                    <div className="text-xs text-gray-400">exp. net {inr(action.expectedNetRecovery)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${
                        action.approvalStatus === 'pending'
                          ? 'border-yellow-300 bg-yellow-50 text-yellow-700'
                          : action.approvalStatus === 'approved'
                            ? 'border-blue-300 bg-blue-50 text-blue-700'
                            : 'border-gray-300 bg-white text-gray-600'
                      }`}
                    >
                      {action.approvalStatus.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded border px-2 py-0.5 text-xs ${statusTone(
                      action.executionStatus === 'EXECUTED' ? 'RECOVERY_IN_PROGRESS' : 'EVALUATED'
                    )}`}>
                      {(action as any).executionStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {outcome ? (
                      outcome.result === 'RECOVERED' ? (
                        <span className="font-medium text-green-700">
                          ✓ Recovered {inr(outcome.recoveredAmount)}
                        </span>
                      ) : (
                        <span className="text-gray-500">Not recovered</span>
                      )
                    ) : (
                      <span className="text-gray-400">{timeAgo((action as any).createdAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
