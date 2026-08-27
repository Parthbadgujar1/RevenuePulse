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
  abandoned: 'bg-amber-100 text-amber-800',
  recovery_sent: 'bg-blue-100 text-blue-800',
  recovered: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
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
    <div className="min-h-screen bg-gray-50">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
          Checkout Abandonment Recovery
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Detect and recover abandoned checkout sessions with targeted incentives.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* Session list */}
          <div className="lg:col-span-1">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold text-gray-900">Sessions ({sessions.length})</p>
              {loading ? (
                <p className="mt-3 text-sm text-gray-500">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">No sessions. Generate demo data in Demo Lab.</p>
              ) : (
                <div className="mt-3 max-h-[600px] space-y-2 overflow-y-auto">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedId(s.sessionId)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        selectedId === s.sessionId
                          ? 'border-emerald-400 bg-emerald-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-gray-500">{s.sessionId.slice(0, 20)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {s.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="font-semibold text-gray-900">{inr(s.amount)}</span>
                        <span className="text-xs text-gray-500">{s.abandonmentReason ?? '—'}</span>
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
              <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 shadow-sm">
                Select a checkout session from the list to view details and trigger recovery.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
