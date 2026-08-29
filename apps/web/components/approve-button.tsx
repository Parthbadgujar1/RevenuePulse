'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfFetch } from '../lib/csrf-client';

export default function ApproveButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await csrfFetch(`/api/cases/${caseId}/approve`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={approve}
        disabled={busy}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Executing…' : 'Approve & Execute Action'}
      </button>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
