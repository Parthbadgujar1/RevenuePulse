'use client';

import { useEffect, useState } from 'react';
import AppNav from '../../components/app-nav';
import CheckoutRecoveryPanel from '../../components/checkout-recovery-panel';

interface Session {
  id: string;
  sessionId: string;
  amount: number;
  currency: string;
  status: string;
  abandonmentReason: string | null;
  customerEmail: string | null;
  createdAt: string;
}

function inr(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);
}

const statusTone: Record<string, string> = {
  abandoned: 'bg-amber-500/10 text-amber-300',
  recovery_sent: 'bg-blue-500/15 text-blue-300',
  recovered: 'bg-emerald-500/15 text-emerald-300',
  expired: 'bg-slate-800 text-slate-400',
};

export default function CheckoutPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/checkout/sessions')
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedId]);

  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
          Checkout Abandonment Recovery
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Detect and recover abandoned checkout sessions with targeted incentives.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* Session list */}
          <div className="lg:col-span-1">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
              <p className="text-sm font-semibold text-slate-100">Sessions ({sessions.length})</p>
              {loading ? (
                <p className="mt-3 text-sm text-slate-400">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">No sessions. Generate demo data in Demo Lab.</p>
              ) : (
                <div className="mt-3 max-h-[600px] space-y-2 overflow-y-auto">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedId(s.sessionId)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        selectedId === s.sessionId
                          ? 'border-emerald-400 bg-emerald-500/10'
                          : 'border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-slate-400">{s.sessionId.slice(0, 20)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone[s.status] ?? 'bg-slate-800 text-slate-400'}`}>
                          {s.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="font-semibold text-slate-100">{inr(s.amount)}</span>
                        <span className="text-xs text-slate-400">{s.abandonmentReason ?? '—'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Selected session detail */}
          <div className="lg:col-span-2">
            {selectedId ? (
              <CheckoutRecoveryPanel sessionId={selectedId} />
            ) : (
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-400 shadow-sm">
                Select a checkout session from the list to view details and trigger recovery.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
