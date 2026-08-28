// Dashboard - Revenue Recovery Overview
// Server component: queries live data from Postgres via Prisma.
// Falls back to an empty state if the database is unreachable.

import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../lib/merchant-context';
import AppNav from '../../components/app-nav';
import Link from 'next/link';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001';

interface ModelInfo {
  ok: boolean;
  version?: string;
  modelType?: string;
  rocAuc?: number;
  prAuc?: number;
  brier?: number;
  rows?: number;
}

async function getModelInfo(): Promise<ModelInfo> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/model-info`, {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    return {
      ok: true,
      version: j.version,
      modelType: j.type,
      rocAuc: j.held_out_test_metrics?.roc_auc,
      prAuc: j.held_out_test_metrics?.pr_auc,
      brier: j.held_out_test_metrics?.brier,
      rows: j.held_out_test_metrics ? undefined : undefined,
    };
  } catch {
    return { ok: false };
  }
}

function inr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

interface CategoryRow {
  name: string;
  amount: number;
  percentage: number;
}

interface CaseRow {
  id: string;
  amount: number;
  status: string;
  priority: number;
  category: string;
  attempts: number;
  createdAt: Date;
}

interface FunnelRow {
  stage: string;
  count: number;
  ofTotal: number;
}

interface MoneyRow {
  label: string;
  amount: number;
}

async function getDashboardData() {
  try {
    const { merchantId } = await requireMerchantContext();
    // RecoveryAction/Prediction/Outcome carry plain id references (no Prisma
    // relations to RevenueCase), so scope everything via the case ids.
    const cases = await prisma.revenueCase.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
    const caseIds = cases.map((c) => c.id);
    const [actions, predictions] = await Promise.all([
      prisma.recoveryAction.findMany({ where: { caseId: { in: caseIds } } }),
      prisma.prediction.findMany({ where: { caseId: { in: caseIds } }, select: { caseId: true } }),
    ]);
    const actionIds = actions.map((a) => a.id);
    const outcomes = await prisma.outcome.findMany({
      where: { actionId: { in: actionIds } },
    });

    const atRisk = cases.reduce((sum, c) => sum + c.amountAtRisk, 0);
    const verifiedRecovered = outcomes
      .filter((o) => o.result === 'RECOVERED')
      .reduce((sum, o) => sum + o.recoveredAmount, 0);
    const adminConfirmedRecovered = outcomes
      .filter((o) => o.result === 'ADMIN_CONFIRMED_RECOVERY')
      .reduce((sum, o) => sum + o.recoveredAmount, 0);
    const recovered = verifiedRecovered + adminConfirmedRecovered;
    const actionCost = outcomes.reduce((sum, o) => sum + o.measuredCost, 0);
    const netRecovered = recovered - actionCost;

    // Real recovery rate: share of at-risk money actually recovered,
    // computed from persisted Outcome rows (not hardcoded).
    const recoveryRate = atRisk > 0 ? (recovered / atRisk) * 100 : 0;

    // Category leakage breakdown from structured diagnoses
    const byCategory: Record<string, number> = {};
    for (const c of cases) {
      const cat =
        ((c.diagnosis as Record<string, unknown> | null)?.primaryCategory as string) ||
        'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + c.amountAtRisk;
    }
    const categories: CategoryRow[] = Object.entries(byCategory)
      .map(([name, amount]) => ({
        name,
        amount,
        percentage: atRisk > 0 ? (amount / atRisk) * 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const recentCases: CaseRow[] = cases.slice(0, 6).map((c) => ({
      id: c.id,
      amount: c.amountAtRisk,
      status: c.status,
      priority: c.priority,
      category:
        ((c.diagnosis as Record<string, unknown> | null)?.primaryCategory as string) ||
        'unknown',
      attempts: c.attemptCount,
      createdAt: c.createdAt,
    }));

    const openCases = cases.filter((c) =>
      ['DETECTED', 'EVALUATED', 'ACTION_PENDING', 'RECOVERY_IN_PROGRESS'].includes(c.status)
    ).length;

    // Recovery funnel: every stage measured from real rows
    const executedActions = actions.filter((a) => a.executionStatus === 'EXECUTED');
    const verifiedOutcomes = outcomes.filter((o) => o.verifiedAt);
    const recoveredOutcomes = outcomes.filter((o) =>
      o.result === 'RECOVERED' || o.result === 'ADMIN_CONFIRMED_RECOVERY'
    );
    const stoppedCases = cases.filter((c) => c.status === 'STOPPED');
    const approvalPendingActions = actions.filter(
      (a) => a.approvalStatus === 'pending' && a.executionStatus !== 'EXECUTED'
    );
    const failedAttempts = verifiedOutcomes.length - recoveredOutcomes.length;
    const eligibleCases = cases.length - stoppedCases.length;
    const funnel: FunnelRow[] = [
      { stage: 'Failures diagnosed', count: cases.length, ofTotal: 1 },
      {
        stage: 'Scored by ML model',
        count: predictions.length,
        ofTotal: cases.length ? predictions.length / cases.length : 0,
      },
      {
        stage: 'Eligible for recovery',
        count: eligibleCases,
        ofTotal: cases.length ? eligibleCases / cases.length : 0,
      },
      {
        stage: 'Actions executed',
        count: executedActions.length,
        ofTotal: cases.length ? executedActions.length / cases.length : 0,
      },
      {
        stage: 'Outcomes verified',
        count: verifiedOutcomes.length,
        ofTotal: cases.length ? verifiedOutcomes.length / cases.length : 0,
      },
      {
        stage: 'Recovered',
        count: recoveredOutcomes.length,
        ofTotal: cases.length ? recoveredOutcomes.length / cases.length : 0,
      },
    ];

    // Money funnel: where the rupees went
    const money: MoneyRow[] = [
      { label: 'At risk', amount: atRisk },
      { label: 'Recovered', amount: recovered },
      { label: 'Action cost', amount: actionCost },
      { label: 'Net recovered', amount: netRecovered },
      ...(adminConfirmedRecovered > 0
        ? [{ label: 'Of which admin-confirmed', amount: adminConfirmedRecovered }]
        : []),
    ];

    return {
      ok: true as const,
      summary: {
        atRisk,
        openCases,
        totalCases: cases.length,
        recovered,
        recoveryRate,
        netRecovered,
        actionCost,
        awaitingApproval: approvalPendingActions.length,
        stoppedByPolicyOrEconomics: stoppedCases.length,
        failedAttempts,
      },
      categories,
      recentCases,
      funnel,
      money,
    };
  } catch (error) {
    console.error('Dashboard data load failed:', error);
    return {
      ok: false as const,
      summary: {
        atRisk: 0,
        openCases: 0,
        totalCases: 0,
        recovered: 0,
        recoveryRate: 0,
        netRecovered: 0,
        actionCost: 0,
        awaitingApproval: 0,
        stoppedByPolicyOrEconomics: 0,
        failedAttempts: 0,
      },
      categories: [] as CategoryRow[],
      recentCases: [] as CaseRow[],
      funnel: [] as FunnelRow[],
      money: [] as MoneyRow[],
    };
  }
}

const STATUS_STYLES: Record<string, string> = {
  DETECTED: 'bg-red-50 border-red-300 text-red-700',
  EVALUATED: 'bg-blue-50 border-blue-300 text-blue-700',
  ACTION_PENDING: 'bg-yellow-50 border-yellow-300 text-yellow-700',
  RECOVERY_IN_PROGRESS: 'bg-purple-50 border-purple-300 text-purple-700',
  RECOVERED: 'bg-green-50 border-green-300 text-green-700',
};

export default async function Dashboard() {
  const { ok, summary, categories, recentCases, funnel, money } = await getDashboardData();
  const model = await getModelInfo();

  return (
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            Revenue Recovery Dashboard
          </h1>
          <Link
            href="/demo-lab"
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
          >
            ▶ Run Demo Batch
          </Link>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Live data · {summary.totalCases} case{summary.totalCases === 1 ? '' : 's'} on record
          {summary.awaitingApproval > 0 && (
            <span className="ml-2 rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
              {summary.awaitingApproval} awaiting approval
            </span>
          )}
        </p>

        {!ok && (
          <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800">
            Database unreachable — showing empty values.
          </div>
        )}

        {/* AI model transparency strip */}
        {model.ok && (
          <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm">
            <span className="font-semibold text-indigo-900">🧠 AI model {model.version}</span>
            <span className="text-indigo-800" title="How well the model ranks recoverable vs hopeless cases (0.5 = coin flip, 1 = perfect)">
              ranking quality (ROC-AUC): <strong>{model.rocAuc?.toFixed(2) ?? '—'}</strong>
            </span>
            <span className="text-indigo-800" title="Precision-recall quality on the recoverable class">
              precision quality (PR-AUC): <strong>{model.prAuc?.toFixed(2) ?? '—'}</strong>
            </span>
            <span className="text-xs text-indigo-700">trained on 60,000 industry-calibrated recovery outcomes · scores are probabilities, not guarantees</span>
          </div>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <div className="p-4 rounded-lg bg-blue-500 text-white shadow">
            <div className="text-2xl sm:text-3xl font-bold">{inr(summary.atRisk)}</div>
            <div className="text-sm opacity-90">Revenue At Risk</div>
          </div>
          <div className="p-4 rounded-lg bg-orange-500 text-white shadow">
            <div className="text-2xl sm:text-3xl font-bold">{summary.openCases}</div>
            <div className="text-sm opacity-90">Open Cases</div>
          </div>
          <div className="p-4 rounded-lg bg-green-500 text-white shadow">
            <div className="text-2xl sm:text-3xl font-bold">{inr(summary.recovered)}</div>
            <div className="text-sm opacity-90">Recovered</div>
          </div>
          <div className="p-4 rounded-lg bg-emerald-600 text-white shadow">
            <div className="text-2xl sm:text-3xl font-bold">
              {summary.recoveryRate.toFixed(1)}%
            </div>
            <div className="text-sm opacity-90">Recovery Rate</div>
          </div>
          <div className="p-4 rounded-lg bg-purple-500 text-white shadow col-span-2 lg:col-span-1">
            <div className="text-2xl sm:text-3xl font-bold">{inr(summary.netRecovered)}</div>
            <div className="text-sm opacity-90">Net Recovered</div>
          </div>
        </div>

        {/* Funnels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <section>
            <h2 className="text-lg font-medium mb-4 text-gray-900">Recovery Funnel</h2>
            <div className="p-3 rounded-lg border border-gray-200 bg-white shadow-sm space-y-2">
              {funnel.length === 0 ? (
                <p className="text-sm text-gray-500 p-2">No data yet.</p>
              ) : (
                funnel.map((f) => (
                  <div key={f.stage}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-medium text-gray-700">{f.stage}</span>
                      <span className="text-gray-500">
                        {f.count} ({(f.ofTotal * 100).toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-2 rounded bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded bg-blue-500"
                        style={{ width: `${Math.max(f.ofTotal * 100, f.count > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-4 text-gray-900">Money Funnel</h2>
            <div className="p-3 rounded-lg border border-gray-200 bg-white shadow-sm">
              {money.length === 0 ? (
                <p className="text-sm text-gray-500 p-2">No data yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {money.map((m) => (
                      <tr key={m.label} className="border-b last:border-b-0 border-gray-100">
                        <td className="py-2 text-gray-700">{m.label}</td>
                        <td
                          className={`py-2 text-right font-semibold ${
                            m.label === 'Net recovered'
                              ? m.amount >= 0
                                ? 'text-green-600'
                                : 'text-red-600'
                              : 'text-gray-900'
                          }`}
                        >
                          {inr(m.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-xs text-gray-400">
                Outcomes in demo mode are simulated from an independent ground-truth propensity.
              </p>
            </div>
          </section>
        </div>

        {/* Funnel explanation */}
        <p className="mb-8 -mt-2 text-xs text-gray-500">
          ⏹ {summary.stoppedByPolicyOrEconomics} stopped by policy/economics · 👤{' '}
          {summary.awaitingApproval} awaiting human approval · ↩︎ {summary.failedAttempts} verified
          attempts did not recover. Every case is clickable in{' '}
          <Link href="/cases" className="font-medium text-emerald-600 hover:underline">Cases</Link> —
          see what the agent decided in{' '}
          <Link href="/actions" className="font-medium text-emerald-600 hover:underline">Recovery Actions</Link>.
        </p>

        {/* Leakage Analysis */}
        <section className="mb-8">
          <h2 className="text-lg font-medium mb-4 text-gray-900">Revenue Leakage by Category</h2>
          {categories.length === 0 ? (
            <p className="p-3 rounded-lg border border-gray-200 bg-white text-sm text-gray-500 shadow-sm">
              No failed payments recorded yet. Send a webhook event to see leakage analysis.
            </p>
          ) : (
            <div className="space-y-3">
              {categories.map((cat) => (
                <div
                  key={cat.name}
                  className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1 text-sm p-3 rounded-lg border border-gray-200 bg-white shadow-sm"
                >
                  <span className="font-medium text-gray-800 capitalize">
                    {cat.name.replace(/_/g, ' ')}
                  </span>
                  <span className="text-gray-600">
                    {inr(cat.amount)} ({cat.percentage.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent Cases */}
        <section>
          <h2 className="text-lg font-medium mb-4 text-gray-900">Recent Cases</h2>
          {recentCases.length === 0 ? (
            <p className="p-3 rounded-lg border border-gray-200 bg-white text-sm text-gray-500 shadow-sm">
              No recovery cases yet.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {recentCases.map((c) => (
                <div
                  key={c.id}
                  className={`p-4 rounded-lg border shadow-sm ${
                    STATUS_STYLES[c.status] || 'border-gray-300 bg-white'
                  }`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <span className="font-semibold text-gray-900">{inr(c.amount)}</span>
                    <span className="text-xs font-medium uppercase tracking-wide">
                      {c.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1 capitalize">
                    {c.category.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Priority {c.priority} · {c.attempts} attempt{c.attempts === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
