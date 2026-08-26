'use client';

import { useEffect, useState } from 'react';

interface AgingBucket {
  label: string;
  count: number;
  amount: number;
}

interface Invoice {
  id: string;
  reference: string;
  customerName: string;
  amount: number;
  status: string;
  overdueDays: number;
  dueDate: string;
}

interface ReceivablesSummary {
  totalPending: number;
  totalOverdue: number;
  collectionRate: number;
  agingBuckets: AgingBucket[];
  recentInvoices: Invoice[];
}

export default function ReceivablesDashboard() {
  const [summary, setSummary] = useState<ReceivablesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chaseInvoiceId, setChaseInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/receivables/summary')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setSummary(d.summary))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function formatCurrency(amount: number) {
    return `₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
  }

  const maxBucketAmount = summary
    ? Math.max(...summary.agingBuckets.map((b) => b.amount), 1)
    : 1;

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Loading receivables…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700 shadow-sm">
        {error}
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-900">Receivables Overview</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Total Pending</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(summary.totalPending)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Total Overdue</p>
            <p className="mt-1 text-lg font-semibold text-red-700">{formatCurrency(summary.totalOverdue)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Collection Rate</p>
            <p className="mt-1 text-lg font-semibold text-emerald-700">{(summary.collectionRate * 100).toFixed(1)}%</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-900">Aging Buckets</p>
        <div className="mt-4 space-y-3">
          {summary.agingBuckets.map((bucket) => (
            <div key={bucket.label} className="flex items-center gap-3">
              <span className="w-16 text-xs font-medium text-gray-500">{bucket.label}</span>
              <div className="flex-1">
                <div className="h-5 w-full rounded bg-gray-100">
                  <div
                    className={`h-5 rounded ${bucket.label.includes('90') ? 'bg-red-400' : bucket.label.includes('61') ? 'bg-amber-400' : bucket.label.includes('31') ? 'bg-yellow-300' : 'bg-emerald-400'}`}
                    style={{ width: `${(bucket.amount / maxBucketAmount) * 100}%` }}
                  />
                </div>
              </div>
              <span className="w-24 text-right text-xs text-gray-600">{formatCurrency(bucket.amount)}</span>
              <span className="w-10 text-right text-xs text-gray-400">{bucket.count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-900">Recent Invoices</p>
          <button className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 border border-emerald-300 hover:bg-emerald-400 transition">
            Create Invoice
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs font-medium uppercase tracking-wide text-gray-400">
                <th className="pb-2 pr-4">Reference</th>
                <th className="pb-2 pr-4">Customer</th>
                <th className="pb-2 pr-4 text-right">Amount</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 text-right">Overdue Days</th>
                <th className="pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {summary.recentInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50">
                  <td className="py-2.5 pr-4 font-medium text-gray-900">{inv.reference}</td>
                  <td className="py-2.5 pr-4 text-gray-700">{inv.customerName}</td>
                  <td className="py-2.5 pr-4 text-right text-gray-900">{formatCurrency(inv.amount)}</td>
                  <td className="py-2.5 pr-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      inv.status === 'PAID'
                        ? 'bg-green-100 text-green-700'
                        : inv.status === 'OVERDUE'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-amber-100 text-amber-800'
                    }`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-xs text-gray-500">
                    {inv.overdueDays > 0 ? inv.overdueDays : '—'}
                  </td>
                  <td className="py-2.5 text-right">
                    {inv.status !== 'PAID' && (
                      <button
                        onClick={() => setChaseInvoiceId(chaseInvoiceId === inv.id ? null : inv.id)}
                        className="text-xs font-medium text-emerald-600 hover:underline"
                      >
                        Chase
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {summary.recentInvoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-sm text-gray-500">No invoices found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
