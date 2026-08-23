// Dashboard - Revenue Recovery Overview
// Server component: queries live data from Postgres via Prisma.
// Falls back to an empty state if the database is unreachable.

import { prisma } from '@rp/database';

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

async function getDashboardData() {
  try {
    const [cases, outcomes] = await Promise.all([
      prisma.revenueCase.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.outcome.findMany(),
    ]);

    const atRisk = cases.reduce((sum, c) => sum + c.amountAtRisk, 0);
    const recovered = outcomes.reduce((sum, o) => sum + o.recoveredAmount, 0);

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

    return {
      ok: true as const,
      summary: {
        atRisk,
        openCases,
        totalCases: cases.length,
        recovered,
        recoveryRate: 0,
      },
      categories,
      recentCases,
    };
  } catch (error) {
    console.error('Dashboard data load failed:', error);
    return {
      ok: false as const,
      summary: { atRisk: 0, openCases: 0, totalCases: 0, recovered: 0, recoveryRate: 0 },
      categories: [] as CategoryRow[],
      recentCases: [] as CaseRow[],
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
  const { ok, summary, categories, recentCases } = await getDashboardData();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold mb-2 text-gray-900">
          RevenuePulse — Revenue Recovery Dashboard
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          Live data · {summary.totalCases} case{summary.totalCases === 1 ? '' : 's'} on record
        </p>

        {!ok && (
          <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800">
            Database unreachable — showing empty values.
          </div>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
          <div className="p-4 rounded-lg bg-purple-500 text-white shadow">
            <div className="text-2xl sm:text-3xl font-bold">{inr(summary.atRisk - summary.recovered)}</div>
            <div className="text-sm opacity-90">Outstanding</div>
          </div>
        </div>

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
