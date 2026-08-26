'use client';

import { useEffect, useState } from 'react';

interface PromiseRecord {
  id: string;
  customerName: string;
  amount: number;
  dueDate: string;
  channel: string;
  escalationLevel: number;
  status: 'PENDING' | 'KEPT' | 'BROKEN' | 'EXTENDED';
  createdAt: string;
}

export default function PromisesTracker() {
  const [promises, setPromises] = useState<PromiseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'KEPT' | 'BROKEN' | 'EXTENDED'>('PENDING');
  const [busy, setBusy] = useState<string | null>(null);
  const [extendId, setExtendId] = useState<string | null>(null);
  const [extendDate, setExtendDate] = useState('');

  useEffect(() => {
    fetch('/api/promises')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setPromises(d.promises))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'ALL' ? promises : promises.filter((p) => p.status === filter);

  const counts = {
    PENDING: promises.filter((p) => p.status === 'PENDING').length,
    KEPT: promises.filter((p) => p.status === 'KEPT').length,
    BROKEN: promises.filter((p) => p.status === 'BROKEN').length,
    EXTENDED: promises.filter((p) => p.status === 'EXTENDED').length,
  };

  function daysUntil(dateStr: string) {
    const diff = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return diff;
  }

  async function resolve(id: string, status: 'KEPT' | 'BROKEN') {
    setBusy(id + status);
    try {
      const res = await fetch(`/api/promises/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setPromises((ps) => ps.map((p) => (p.id === id ? { ...p, status } : p)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function extendPromise(id: string) {
    if (!extendDate) return;
    setBusy(id + 'EXTEND');
    try {
      const res = await fetch(`/api/promises/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'EXTENDED', newDueDate: extendDate }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setPromises((ps) => ps.map((p) => (p.id === id ? { ...p, status: 'EXTENDED', dueDate: extendDate } : p)));
      setExtendId(null);
      setExtendDate('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
        Loading promises…
      </div>
    );
  }

  const statusTone: Record<string, string> = {
    PENDING: 'bg-amber-100 text-amber-800',
    KEPT: 'bg-green-100 text-green-800',
    BROKEN: 'bg-red-100 text-red-800',
    EXTENDED: 'bg-blue-100 text-blue-800',
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-900">Promise-to-Pay Tracker</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(['PENDING', 'KEPT', 'BROKEN', 'EXTENDED'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                filter === f
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
              }`}
            >
              {f.charAt(0) + f.slice(1).toLowerCase()} ({counts[f]})
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      <div className="space-y-3">
        {filtered.map((p) => {
          const remaining = daysUntil(p.dueDate);
          return (
            <div key={p.id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{p.customerName}</p>
                  <p className="text-xs text-gray-500">
                    ₹{(p.amount / 100).toLocaleString('en-IN')} · {p.channel}
                    {p.escalationLevel > 0 && ` · Level ${p.escalationLevel}`}
                  </p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[p.status]}`}>
                  {p.status}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                <span>
                  Due: {new Date(p.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
                {p.status === 'PENDING' && (
                  <span className={`font-medium ${remaining < 0 ? 'text-red-600' : remaining <= 2 ? 'text-amber-600' : 'text-gray-600'}`}>
                    {remaining < 0 ? `${Math.abs(remaining)}d overdue` : remaining === 0 ? 'Due today' : `${remaining}d remaining`}
                  </span>
                )}
              </div>

              {p.status === 'PENDING' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => resolve(p.id, 'KEPT')}
                    disabled={busy !== null}
                    className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 border border-emerald-300 hover:bg-emerald-400 disabled:opacity-60 transition"
                  >
                    {busy === p.id + 'KEPT' ? 'Working…' : 'Mark Kept'}
                  </button>
                  <button
                    onClick={() => resolve(p.id, 'BROKEN')}
                    disabled={busy !== null}
                    className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 transition"
                  >
                    {busy === p.id + 'BROKEN' ? 'Working…' : 'Mark Broken'}
                  </button>
                  {extendId === p.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={extendDate}
                        onChange={(e) => setExtendDate(e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs"
                      />
                      <button
                        onClick={() => extendPromise(p.id)}
                        disabled={busy !== null || !extendDate}
                        className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60 transition"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => { setExtendId(null); setExtendDate(''); }}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setExtendId(p.id)}
                      disabled={busy !== null}
                      className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60 transition"
                    >
                      Extend
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 shadow-sm">
            No promises found for this filter.
          </div>
        )}
      </div>
    </div>
  );
}
