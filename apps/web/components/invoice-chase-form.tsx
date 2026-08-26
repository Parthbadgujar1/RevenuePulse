'use client';

import { useState } from 'react';

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
] as const;

export default function InvoiceChaseForm({
  invoiceId,
  onSuccess,
}: {
  invoiceId: string;
  onSuccess?: () => void;
}) {
  const [channel, setChannel] = useState<string>('email');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/receivables/invoices/${invoiceId}/chase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, message: message || undefined }),
      });
      const j = await res.json();
      if (!res.ok) {
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setResult({ ok: true, text: 'Payment reminder sent successfully.' });
      onSuccess?.();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Channel</label>
        <div className="mt-2 flex gap-2">
          {CHANNELS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setChannel(c.value)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                channel === c.value
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
          Message <span className="font-normal normal-case">(optional)</span>
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="Custom message to include in the reminder…"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400"
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 border border-emerald-300 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? 'Sending…' : 'Send Reminder'}
      </button>

      {result && (
        <p className={`rounded-lg border px-3 py-2 text-sm ${
          result.ok
            ? 'border-green-300 bg-green-50 text-green-800'
            : 'border-red-300 bg-red-50 text-red-800'
        }`}>
          {result.text}
        </p>
      )}
    </form>
  );
}
