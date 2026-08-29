'use client';

import { useEffect, useState } from 'react';
import { csrfFetch } from '../lib/csrf-client';

interface CheckoutSession {
  id: string;
  sessionId: string;
  amount: number;
  currency: string;
  abandonmentReason: string;
  status: string;
  incentiveType: string | null;
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
      const res = await csrfFetch('/api/checkout/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setSuccess('Recovery email sent successfully.');
      setSession((s) => (s ? { ...s, status: 'recovery_sent' } : s));
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
      const res = await csrfFetch('/api/checkout/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, action: 'mark_recovered' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setSuccess('Checkout marked as recovered.');
      setSession((s) => (s ? { ...s, status: 'recovered' } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        Loading checkout session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        No checkout session selected.
      </div>
    );
  }

  const statusTone: Record<string, string> = {
    abandoned: 'bg-amber-500/10 text-amber-300',
    recovery_sent: 'bg-blue-500/15 text-blue-300',
    recovered: 'bg-emerald-500/15 text-emerald-300',
    expired: 'bg-slate-800 text-slate-400',
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-100">Checkout Recovery</p>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[session.status] ?? 'bg-slate-800 text-slate-400'}`}>
          {session.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount</p>
          <p className="mt-1 text-lg font-semibold text-slate-100">
            {session.currency.toUpperCase()} {(session.amount / 100).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Abandonment Reason</p>
          <p className="mt-1 text-sm text-slate-200">{session.abandonmentReason ?? 'Unknown'}</p>
        </div>
        {session.incentiveType && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Incentive Applied</p>
            <p className="mt-1 text-sm text-slate-200">{session.incentiveType}</p>
          </div>
        )}
        {session.customerEmail && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Customer</p>
            <p className="mt-1 text-sm text-slate-200">{session.customerEmail}</p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {session.status !== 'recovered' && (
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
              className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'mark' ? 'Working…' : 'Mark Recovered'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      {success && (
        <p className="mt-3 rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{success}</p>
      )}
    </div>
  );
}
