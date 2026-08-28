'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfFetch } from '../lib/csrf-client';

interface AdminAction {
  action: string;
  label: string;
  description: string;
  variant: 'primary' | 'secondary' | 'danger';
}

const VARIANT_STYLES: Record<string, string> = {
  primary:
    'bg-emerald-500 text-slate-950 hover:bg-emerald-400 border-emerald-300',
  secondary:
    'bg-white text-gray-700 hover:bg-gray-50 border-gray-300',
  danger:
    'bg-red-50 text-red-700 hover:bg-red-100 border-red-300',
};

export default function AdminActions({
  caseId,
  actions,
}: {
  caseId: string;
  actions: AdminAction[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (actions.length === 0) return null;

  async function run(action: string) {
    if (!confirm(`Are you sure you want to ${action.replace(/_/g, ' ')}?`)) return;
    setBusy(action);
    setError(null);
    setSuccess(null);
    try {
      const res = await csrfFetch(`/api/cases/${caseId}/admin-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const j = await res.json();
      setSuccess(`Done — case is now ${j.status}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-gray-900">Admin Controls</p>
      <p className="mt-0.5 text-xs text-gray-500">
        Override the automatic decision. The AI still suggests the best path — you decide.
      </p>

      <div className="mt-3 space-y-2">
        {actions.map((a) => (
          <div key={a.action} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <button
              onClick={() => run(a.action)}
              disabled={busy !== null}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT_STYLES[a.variant]}`}
            >
              {busy === a.action ? 'Working…' : a.label}
            </button>
            <span className="text-xs text-gray-500">{a.description}</span>
          </div>
        ))}
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
