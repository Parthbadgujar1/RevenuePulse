'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface VerifyResult {
  checked?: number;
  recovered?: number;
  notRecovered?: number;
  error?: string;
}

export default function VerifyOutcomeButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function verify() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/outcomes/verify', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) {
        setResult({ error: j.error || `Request failed (${res.status})` });
      } else {
        setResult(j);
        if ((j.checked ?? 0) > 0) router.refresh();
      }
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        onClick={verify}
        disabled={busy}
        className="rounded-lg border border-orange-400 bg-white px-3 py-1.5 text-xs font-semibold text-orange-800 transition hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Checking with Razorpay…' : 'Verify now via Razorpay API'}
      </button>
      {result?.error && <p className="mt-2 text-xs text-red-600">{result.error}</p>}
      {result && !result.error && (
        <p className="mt-2 text-xs text-orange-800">
          Checked {result.checked ?? 0} payment(s): {result.recovered ?? 0} recovered ·{' '}
          {result.notRecovered ?? 0} not recovered — recorded exactly as the provider reports.
        </p>
      )}
    </div>
  );
}
