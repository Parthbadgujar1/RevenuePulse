'use client';

import { useEffect, useState } from 'react';

interface CheckoutSession {
  id: string;
  amount: number;
  currency: string;
  abandonmentReason: string;
  recoveryStatus: string;
  incentiveApplied: string | null;
  customerEmail: string | null;
  createdAt: string;
}

export default function CheckoutRecoveryPanel({ sessionId }: { sessionId?: string }) {
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [loading, setLoading] = useState(!!sessionId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`/api/checkout/status?sessionId=${sessionId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setSession(d.session))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  async function sendRecovery() {
    if (!session) return;
    setBusy('recover');
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/checkout/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setSuccess('Recovery email sent successfully.');
      setSession((s) => (s ? { ...s, recoveryStatus: 'RECOVERY_SENT' } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function markRecovered() {
    if (!session) return;
    setBusy('mark');
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/checkout/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, action: 'mark_recovered' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setSuccess('Checkout marked as recovered.');
      setSession((s) => (s ? { ...s, recoveryStatus: 'RECOVERED' } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Loading checkout session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        No checkout session selected.
      </div>
    );
  }

  const statusTone: Record<string, string> = {
    ABANDONED: 'bg-amber-100 text-amber-800',
    RECOVERY_SENT: 'bg-blue-100 text-blue-800',
    RECOVERED: 'bg-green-100 text-green-800',
    EXPIRED: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">Checkout Recovery</p>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[session.recoveryStatus] ?? 'bg-gray-100 text-gray-600'}`}>
          {session.recoveryStatus.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Amount</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {session.currency.toUpperCase()} {(session.amount / 100).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abandonment Reason</p>
          <p className="mt-1 text-sm text-gray-800">{session.abandonmentReason}</p>
        </div>
        {session.incentiveApplied && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Incentive Applied</p>
            <p className="mt-1 text-sm text-gray-800">{session.incentiveApplied}</p>
          </div>
        )}
        {session.customerEmail && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Customer</p>
            <p className="mt-1 text-sm text-gray-800">{session.customerEmail}</p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {session.recoveryStatus !== 'RECOVERED' && (
          <>
            <button
              onClick={sendRecovery}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 border border-emerald-300 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'recover' ? 'Working…' : 'Send Recovery'}
            </button>
            <button
              onClick={markRecovered}
              disabled={busy !== null}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'mark' ? 'Working…' : 'Mark Recovered'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}
      {success && (
        <p className="mt-3 rounded bg-green-50 px-3 py-2 text-xs text-green-700">{success}</p>
      )}
    </div>
  );
}
