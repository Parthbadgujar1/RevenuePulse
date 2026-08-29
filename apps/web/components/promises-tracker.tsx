'use client';

import { useEffect, useState } from 'react';
import { csrfFetch } from '../lib/csrf-client';

interface PromiseRecord {
  id: string;
  customerEmail: string;
  promisedAmount: number;
  promisedDate: string;
  channel: string;
  escalationLevel: number;
  status: 'pending' | 'kept' | 'broken' | 'extended';
  createdAt: string;
}

export default function PromisesTracker() {
  const [promises, setPromises] = useState<PromiseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'kept' | 'broken' | 'extended'>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [extendId, setExtendId] = useState<string | null>(null);
  const [extendDate, setExtendDate] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ customerEmail: '', promisedAmount: '', promisedDate: '', channel: 'phone', agentNotes: '' });

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

  function refreshData() {
    setError(null);
    fetch('/api/promises')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then((d) => setPromises(d.promises))
      .catch((e) => setError((e as Error).message));
  }

  async function createPromise() {
    setCreating(true);
    try {
      const res = await csrfFetch('/api/promises', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerEmail: createForm.customerEmail,
          promisedAmount: Number(createForm.promisedAmount) * 100,
          promisedDate: createForm.promisedDate,
          channel: createForm.channel,
          agentNotes: createForm.agentNotes || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const { promise } = await res.json();
      setPromises((ps) => [promise, ...ps]);
      setShowCreate(false);
      setCreateForm({ customerEmail: '', promisedAmount: '', promisedDate: '', channel: 'phone', agentNotes: '' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function deletePromise(id: string) {
    if (!confirm('Delete this promise?')) return;
    setBusy(id + 'DELETE');
    try {
      const res = await csrfFetch(`/api/promises?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setPromises((ps) => ps.filter((p) => p.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const filtered = filter === 'all' ? promises : promises.filter((p) => p.status === filter);

  const counts = {
    pending: promises.filter((p) => p.status === 'pending').length,
    kept: promises.filter((p) => p.status === 'kept').length,
    broken: promises.filter((p) => p.status === 'broken').length,
    extended: promises.filter((p) => p.status === 'extended').length,
  };

  function daysUntil(dateStr: string) {
    const diff = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return diff;
  }

  async function resolve(id: string, status: 'kept' | 'broken') {
    setBusy(id + status);
    try {
      const res = await csrfFetch(`/api/promises/${id}/resolve`, {
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
      const res = await csrfFetch(`/api/promises/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'extended', newDueDate: extendDate }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setPromises((ps) => ps.map((p) => (p.id === id ? { ...p, status: 'extended', dueDate: extendDate } : p)));
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
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400 shadow-sm">
        Loading promises…
      </div>
    );
  }

  const statusTone: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-300',
    kept: 'bg-emerald-500/15 text-emerald-300',
    broken: 'bg-red-500/15 text-red-300',
    extended: 'bg-blue-500/15 text-blue-300',
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-100">Promise-to-Pay Tracker</p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 border border-emerald-300 hover:bg-emerald-400 transition"
          >
            {showCreate ? 'Close' : 'Create Promise'}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {(['pending', 'kept', 'broken', 'extended'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                filter === f
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-800 bg-slate-900 text-slate-400 hover:bg-slate-900'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
            </button>
          ))}
        </div>

        {showCreate && (
          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Customer Email</label>
                <input
                  type="email"
                  required
                  value={createForm.customerEmail}
                  onChange={(e) => setCreateForm((f) => ({ ...f, customerEmail: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Amount (₹)</label>
                <input
                  type="number"
                  required
                  min="1"
                  value={createForm.promisedAmount}
                  onChange={(e) => setCreateForm((f) => ({ ...f, promisedAmount: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
                  placeholder="5000"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Promised Date</label>
                <input
                  type="date"
                  required
                  value={createForm.promisedDate}
                  onChange={(e) => setCreateForm((f) => ({ ...f, promisedDate: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Channel</label>
                <select
                  required
                  value={createForm.channel}
                  onChange={(e) => setCreateForm((f) => ({ ...f, channel: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
                >
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Agent Notes (optional)</label>
              <textarea
                value={createForm.agentNotes}
                onChange={(e) => setCreateForm((f) => ({ ...f, agentNotes: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
                rows={2}
                placeholder="Internal notes…"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={createPromise}
                disabled={creating || !createForm.customerEmail || !createForm.promisedAmount || !createForm.promisedDate}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 border border-emerald-300 hover:bg-emerald-400 disabled:opacity-60 transition"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      <div className="space-y-3">
        {filtered.map((p) => {
          const remaining = daysUntil(p.promisedDate);
          return (
            <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{p.customerEmail}</p>
                  <p className="text-xs text-slate-400">
                    ₹{(p.promisedAmount / 100).toLocaleString('en-IN')} · {p.channel}
                    {p.escalationLevel > 0 && ` · Level ${p.escalationLevel}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone[p.status]}`}>
                    {p.status}
                  </span>
                  <button
                    onClick={() => deletePromise(p.id)}
                    disabled={busy !== null}
                    title="Delete promise"
                    className="rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-60 transition"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-4 text-xs text-slate-400">
                <span>
                  Due: {new Date(p.promisedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
                {p.status === 'pending' && (
                  <span className={`font-medium ${remaining < 0 ? 'text-red-400' : remaining <= 2 ? 'text-amber-600' : 'text-slate-400'}`}>
                    {remaining < 0 ? `${Math.abs(remaining)}d overdue` : remaining === 0 ? 'Due today' : `${remaining}d remaining`}
                  </span>
                )}
              </div>

              {p.status === 'pending' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => resolve(p.id, 'kept')}
                    disabled={busy !== null}
                    className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 border border-emerald-300 hover:bg-emerald-400 disabled:opacity-60 transition"
                  >
                    {busy === p.id + 'kept' ? 'Working…' : 'Mark Kept'}
                  </button>
                  <button
                    onClick={() => resolve(p.id, 'broken')}
                    disabled={busy !== null}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/15 disabled:opacity-60 transition"
                  >
                    {busy === p.id + 'broken' ? 'Working…' : 'Mark Broken'}
                  </button>
                  {extendId === p.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={extendDate}
                        onChange={(e) => setExtendDate(e.target.value)}
                        className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs"
                      />
                      <button
                        onClick={() => extendPromise(p.id)}
                        disabled={busy !== null || !extendDate}
                        className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/10 disabled:opacity-60 transition"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => { setExtendId(null); setExtendDate(''); }}
                        className="text-xs text-slate-500 hover:text-slate-400"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setExtendId(p.id)}
                      disabled={busy !== null}
                      className="rounded-lg border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-900 disabled:opacity-60 transition"
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
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-400 shadow-sm">
            No promises found for this filter.
          </div>
        )}
      </div>
    </div>
  );
}
