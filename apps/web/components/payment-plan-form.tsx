'use client';

import { useState, useMemo } from 'react';
import { csrfFetch } from '../lib/csrf-client';

export default function PaymentPlanForm({
  invoiceId,
  totalAmount,
  onSuccess,
}: {
  invoiceId: string;
  totalAmount: number;
  onSuccess?: () => void;
}) {
  const [installments, setInstallments] = useState(3);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const schedule = useMemo(() => {
    const perInstallment = Math.ceil(totalAmount / installments);
    const dates: { number: number; amount: number; date: string }[] = [];
    const start = new Date(startDate);
    for (let i = 0; i < installments; i++) {
      const d = new Date(start);
      d.setMonth(d.getMonth() + i);
      const isLast = i === installments - 1;
      dates.push({
        number: i + 1,
        amount: isLast ? totalAmount - perInstallment * (installments - 1) : perInstallment,
        date: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      });
    }
    return dates;
  }, [totalAmount, installments, startDate]);

  function formatCurrency(amount: number) {
    return `₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      const res = await csrfFetch(`/api/receivables/invoices/${invoiceId}/payment-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installments, startDate }),
      });
      const j = await res.json();
      if (!res.ok) {
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setResult({ ok: true, text: 'Payment plan created successfully.' });
      onSuccess?.();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Invoice Total</p>
        <p className="mt-1 text-lg font-semibold text-slate-100">{formatCurrency(totalAmount)}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Installments</label>
          <select
            value={installments}
            onChange={(e) => setInstallments(Number(e.target.value))}
            disabled={saving}
            className="mt-1 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm"
          >
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>{n} installments</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={saving}
            className="mt-1 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment Schedule Preview</p>
        <div className="mt-2 divide-y divide-gray-100">
          {schedule.map((s) => (
            <div key={s.number} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-400">Installment {s.number}</span>
              <span className="text-slate-400">{s.date}</span>
              <span className="font-medium text-slate-100">{formatCurrency(s.amount)}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-slate-800 pt-2 text-sm font-semibold">
          <span className="text-slate-100">Total</span>
          <span className="text-slate-100">{formatCurrency(totalAmount)}</span>
        </div>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 border border-emerald-300 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? 'Creating…' : 'Create Payment Plan'}
      </button>

      {result && (
        <p className={`rounded-lg border px-3 py-2 text-sm ${
          result.ok
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/30 bg-red-500/10 text-red-300'
        }`}>
          {result.text}
        </p>
      )}
    </form>
  );
}
