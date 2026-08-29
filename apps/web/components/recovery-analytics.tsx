'use client';

import { useEffect, useState } from 'react';

interface MethodBreakdown {
  method: string;
  totalCases: number;
  recoveredCases: number;
  totalAmountAtRisk: number;
  totalRecovered: number;
  recoveryRate: number;
}

interface CategoryBreakdown {
  category: string;
  totalCases: number;
  recoveredCases: number;
  totalAmountAtRisk: number;
  totalRecovered: number;
  recoveryRate: number;
}

interface RecoveryAnalyticsData {
  overallRate: number;
  totalCases: number;
  totalRecovered: number;
  totalAmountAtRisk: number;
  totalRecoveredAmount: number;
  byPaymentMethod: MethodBreakdown[];
  byFailureCategory: CategoryBreakdown[];
}

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
] as const;

export default function RecoveryAnalytics() {
  const [data, setData] = useState<RecoveryAnalyticsData | null>(null);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/analytics/recovery-rates?period=${period}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setData(d.analytics))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [period]);

  const methodLabels: Record<string, string> = {
    upi: 'UPI',
    card: 'Card',
    netbanking: 'Netbanking',
    wallet: 'Wallet',
    emi: 'EMI',
  };

  const categoryLabels: Record<string, string> = {
    NETWORK_FAILURE: 'Network failure',
    INSUFFICIENT_FUNDS: 'Insufficient funds',
    CARD_DECLINED: 'Card declined',
    BANK_TIMEOUT: 'Bank timeout',
    FRAUD_SUSPECTED: 'Fraud suspected',
    EXPIRED_CARD: 'Expired card',
    GENERIC: 'Generic',
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        Loading analytics…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300 shadow-sm">
        {error}
      </div>
    );
  }

  if (!data) return null;

  function inr(paise: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: 0,
    }).format(paise / 100);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">Recovery Analytics</p>
          <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  period === p.value
                    ? 'bg-slate-900 text-slate-100 shadow-sm'
                    : 'text-slate-400 hover:text-slate-300'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Overall Recovery Rate</p>
            <p className="mt-1 text-2xl font-bold text-emerald-300">{data.overallRate.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Cases</p>
            <p className="mt-1 text-2xl font-bold text-slate-100">{data.totalCases.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount Recovered</p>
            <p className="mt-1 text-2xl font-bold text-slate-100">{inr(data.totalRecoveredAmount)}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-100">By Payment Method</p>
          <div className="mt-4 space-y-3">
            {data.byPaymentMethod.map((m) => (
              <div key={m.method}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-300">{methodLabels[m.method] ?? m.method}</span>
                  <span className="text-slate-400">{m.recoveryRate.toFixed(1)}% ({m.recoveredCases}/{m.totalCases})</span>
                </div>
                <div className="mt-1 h-2.5 w-full rounded-full bg-slate-800">
                  <div
                    className="h-2.5 rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.min(m.recoveryRate, 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {data.byPaymentMethod.length === 0 && (
              <p className="text-sm text-slate-400">No data available.</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-100">By Failure Category</p>
          <div className="mt-4 space-y-3">
            {data.byFailureCategory.map((c) => (
              <div key={c.category}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-300">{categoryLabels[c.category] ?? c.category}</span>
                  <span className="text-slate-400">{c.recoveryRate.toFixed(1)}% ({c.recoveredCases}/{c.totalCases})</span>
                </div>
                <div className="mt-1 h-2.5 w-full rounded-full bg-slate-800">
                  <div
                    className={`h-2.5 rounded-full transition-all ${c.recoveryRate >= 70 ? 'bg-emerald-500' : c.recoveryRate >= 40 ? 'bg-amber-400' : 'bg-red-400'}`}
                    style={{ width: `${Math.min(c.recoveryRate, 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {data.byFailureCategory.length === 0 && (
              <p className="text-sm text-slate-400">No data available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
