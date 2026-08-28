'use client';

import { useState } from 'react';
import { csrfFetch } from '../lib/csrf-client';

interface DemoResult {
  ok: boolean;
  created: number;
  note?: string;
  error?: string;
}

const DEMO_TYPES = [
  { key: 'checkout', label: 'Checkout Sessions', desc: 'Abandoned checkouts with incentives', api: '/api/demo-lab/generate-checkout' },
  { key: 'receivables', label: 'B2B Invoices', desc: 'Overdue invoices with aging buckets', api: '/api/demo-lab/generate-receivables' },
  { key: 'promises', label: 'Promise-to-Pay', desc: 'Customer payment commitments', api: '/api/demo-lab/generate-promises' },
];

export default function DemoGeneratePanel() {
  const [results, setResults] = useState<Record<string, DemoResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function generate(api: string, key: string) {
    setBusy(key);
    setResults((r) => ({ ...r, [key]: undefined as any }));
    try {
      const res = await csrfFetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 20, seed: Date.now() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed');
      setResults((r) => ({ ...r, [key]: { ok: true, created: j.created, note: j.note } }));
    } catch (e: any) {
      setResults((r) => ({ ...r, [key]: { ok: false, created: 0, error: e.message } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-gray-900">Generate Demo Data</h2>
      <p className="mt-1 text-sm text-gray-500">
        Populate checkout, receivables, and promises pages with sample data to explore all features.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {DEMO_TYPES.map((dt) => {
          const result = results[dt.key];
          return (
            <div key={dt.key} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm font-semibold text-gray-900">{dt.label}</p>
              <p className="mt-0.5 text-xs text-gray-500">{dt.desc}</p>
              <button
                onClick={() => generate(dt.api, dt.key)}
                disabled={busy !== null}
                className="mt-3 w-full rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
              >
                {busy === dt.key ? 'Generating…' : result?.ok ? `Regenerate (${result.created})` : 'Generate 20'}
              </button>
              {result?.ok && (
                <p className="mt-1 text-[11px] text-green-600">Created {result.created} records</p>
              )}
              {result?.error && (
                <p className="mt-1 text-[11px] text-red-600">{result.error}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
