'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { inr } from '../lib/ui';
import { csrfFetch } from '../lib/csrf-client';

interface ManualResult {
  success?: boolean;
  data?: {
    submitted: number;
    processed: number;
    duplicatesSkipped: number;
    pipelineErrors: number;
    casesCreated: number;
    actionsCreated: number;
    caseIds: string[];
  };
  error?: { message?: string };
}

const METHODS = ['card', 'upi', 'netbanking', 'wallet', 'emi', 'other'];

export function QuickAddForm() {
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'failed' | 'captured'>('failed');
  const [method, setMethod] = useState('card');
  const [errorCode, setErrorCode] = useState('');
  const [errorDescription, setErrorDescription] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [providerTxnId, setProviderTxnId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualResult | null>(null);
  const [error, setError] = useState('');

  const reset = () => {
    setAmount('');
    setErrorCode('');
    setErrorDescription('');
    setEmail('');
    setPhone('');
    setProviderTxnId('');
    setResult(null);
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await csrfFetch('/api/ingest/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: {
            providerTxnId: providerTxnId.trim() || undefined,
            amount,
            status,
            method,
            errorCode: errorCode.trim() || undefined,
            errorDescription: errorDescription.trim() || undefined,
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
          },
        }),
      });
      const json = (await res.json()) as ManualResult;
      if (!res.ok) {
        setError(json?.error?.message || 'Could not add payment');
      } else {
        setResult(json);
      }
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">⚡ Quick add a failed payment</h2>
      <p className="mt-1 text-sm text-slate-400">
        Type a single failed payment and run it through the AI recovery pipeline — no file needed.
      </p>

      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Amount (₹) <span className="text-red-400">*</span>
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            step="0.01"
            min="0"
            required
            placeholder="e.g. 499.00"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">Payment ID (optional)</span>
          <input
            value={providerTxnId}
            onChange={(e) => setProviderTxnId(e.target.value)}
            placeholder="e.g. pay_AbC123"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'failed' | 'captured')}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="failed">Failed</option>
            <option value="captured">Captured (context)</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">Payment method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Error code <span className="text-slate-500">(drives the AI diagnosis)</span>
          </span>
          <input
            value={errorCode}
            onChange={(e) => setErrorCode(e.target.value)}
            placeholder="e.g. INSUFFICIENT_FUNDS, CARD_EXPIRED, BANK_DECLINED"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-400">Error description</span>
          <input
            value={errorDescription}
            onChange={(e) => setErrorDescription(e.target.value)}
            placeholder="Free-text reason (optional)"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">Customer email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="cust@example.com"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-400">Customer phone</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="9876543210"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 sm:col-span-2">
            {error}
          </p>
        )}

        {result && result.data && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 sm:col-span-2">
            <p className="text-sm font-semibold text-emerald-300">
              {result.data.casesCreated > 0
                ? `✅ Added — ${result.data.casesCreated} recovery case created`
                : result.data.pipelineErrors > 0
                  ? '⚠️ Could not run that payment'
                  : '✅ Recorded (no recovery case — check the amount or status)'}
            </p>
            <p className="mt-1 text-xs text-emerald-300">
              {result.data.processed} processed · {result.data.actionsCreated} action
              {result.data.actionsCreated === 1 ? '' : 's'} decided
              {result.data.duplicatesSkipped > 0 ? ` · ${result.data.duplicatesSkipped} duplicate` : ''}
            </p>
            {result.data.caseIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {result.data.caseIds.map((id) => (
                  <Link
                    key={id}
                    href={`/cases/${id}`}
                    className="rounded border border-emerald-500/50 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10"
                  >
                    Open case
                  </Link>
                ))}
                <Link
                  href="/dashboard"
                  className="rounded border border-emerald-500/50 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10"
                >
                  View dashboard
                </Link>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy || !amount}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy ? 'Running AI pipeline…' : `Run recovery on ${amount ? inr(Math.round(parseFloat(amount) * 100)) : '…'}`}
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Clear
          </button>
        </div>
      </form>
    </div>
  );
}
