'use client';

import { useCallback, useRef, useState } from 'react';
import { inr } from '../lib/ui';

interface MappingDetail {
  field: string;
  header: string;
  confidence: number;
}

interface Preview {
  fileName: string;
  fileType?: string;
  headers: string[];
  mapping: MappingDetail[];
  unmappedHeaders: string[];
  totalRows: number;
  failureCount: number;
  capturedCount: number;
  skipped: Record<string, number>;
  estimatedAtRiskInr: number;
  categoryCounts: Record<string, number>;
  sampleRows: Record<string, unknown>[];
  ingested: boolean;
  processed?: number;
  pipelineErrors?: number;
  casesCreated?: number;
  actionsCreated?: number;
  note?: string;
}

const FIELD_LABELS: Record<string, string> = {
  provider_txn_id: 'Payment ID',
  amount: 'Amount',
  currency: 'Currency',
  status: 'Status',
  method: 'Payment method',
  error_code: 'Error code',
  error_description: 'Error description',
  created_at: 'Date / time',
  email: 'Customer email',
  phone: 'Customer phone',
};

const ACCEPTED = '.csv,.xlsx,.xls,.pdf';

export default function IngestForm() {
  const [file, setFile] = useState<File | null>(null);
  const [amountUnit, setAmountUnit] = useState<'auto' | 'rupees' | 'paise'>('auto');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'ingest' | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyze = useCallback(
    async (f: File) => {
      setFile(f);
      setPreview(null);
      setError('');
      setBusy('analyze');
      try {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('dryRun', 'true');
        fd.append('amountUnit', amountUnit);
        const res = await fetch('/api/ingest', { method: 'POST', body: fd });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Analysis failed');
        setPreview(json);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(null);
      }
    },
    [amountUnit],
  );

  const reanalyze = useCallback(
    (unit: 'auto' | 'rupees' | 'paise') => {
      setAmountUnit(unit);
      if (file) void analyze(file);
    },
    [file, analyze],
  );

  const ingest = useCallback(async () => {
    if (!file) return;
    setBusy('ingest');
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('dryRun', 'false');
      fd.append('amountUnit', amountUnit);
      const res = await fetch('/api/ingest', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ingest failed');
      setPreview(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, [file, amountUnit]);

  return (
    <div className="space-y-6">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void analyze(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition ${
          dragOver ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 bg-white hover:border-indigo-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void analyze(f);
          }}
        />
        <p className="text-4xl">📥</p>
        <p className="mt-2 font-semibold text-gray-900">
          {busy === 'analyze' ? 'Analyzing…' : 'Drop your payment export here'}
        </p>
        <p className="text-sm text-gray-500">
          CSV · Excel (.xlsx/.xls) · PDF report — or click to browse (max 10 MB, 5,000 rows)
        </p>
      </div>

      <div className="grid gap-3 text-sm text-gray-600 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="font-medium text-gray-800">Automatic column mapping</p>
          Detects amount, status, method, error code/date columns by fuzzy header matching — any export format works.
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="font-medium text-gray-800">Same AI pipeline</p>
          Imported failures flow through the exact diagnose → predict → decide → execute → verify workflow as live webhooks.
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="font-medium text-gray-800">Razorpay API too</p>
          Prefer keys over files? Connect real API keys under Integrations and pull failed payments directly.
        </div>
      </div>

      {/* Sample Templates */}
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
        <p className="text-sm font-semibold text-indigo-900">Sample CSV Templates</p>
        <p className="mt-1 text-xs text-indigo-700">
          Download a template to see the expected column format for each data type.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <TemplateDownload name="payments" headers="payment_id,amount,status,method,error_code,error_description,created_at,currency,email,phone" sample="pay_001,50000,failed,card,INSUFFICIENT_FUNDS,Insufficient funds,2026-08-20T10:00:00Z,INR,user@example.com,9876543210" />
          <TemplateDownload name="checkout-sessions" headers="session_id,amount,currency,abandonment_reason,customer_email,status" sample="cs_001,75000,INR,payment_failed,cust@example.com,abandoned" />
          <TemplateDownload name="invoices" headers="reference,customer_name,customer_email,amount,currency,due_date,status" sample="INV-001,Acme Corp,acme@example.com,500000,INR,2026-09-01,pending" />
          <TemplateDownload name="promises" headers="customer_email,amount,currency,promised_date,channel,status" sample="cust@example.com,25000,INR,2026-09-05,phone,pending" />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Analysis results */}
      {preview && !preview.ingested && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-gray-900">
              📄 {preview.fileName} — detected {preview.totalRows.toLocaleString()} rows
            </h2>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Amounts are in:
              <select
                value={amountUnit}
                onChange={(e) => reanalyze(e.target.value as typeof amountUnit)}
                className="rounded border border-gray-300 px-2 py-1 text-xs"
              >
                <option value="auto">Auto-detect</option>
                <option value="rupees">Rupees (₹)</option>
                <option value="paise">Paise</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Failed payments" value={preview.failureCount.toLocaleString()} tone="red" />
            <Kpi label="Successful (context)" value={preview.capturedCount.toLocaleString()} tone="green" />
            <Kpi label="Est. at risk" value={inr(Math.round(preview.estimatedAtRiskInr * 100))} />
            <Kpi label="Skipped rows" value={Object.values(preview.skipped).reduce((a, b) => a + b, 0).toLocaleString()} />
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Column mapping
            </p>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {preview.mapping.map((m) => (
                    <tr key={m.field}>
                      <td className="px-3 py-1.5 font-medium text-gray-800">{FIELD_LABELS[m.field] ?? m.field}</td>
                      <td className="px-3 py-1.5 text-gray-500">← “{m.header}”</td>
                      <td className="px-3 py-1.5 text-right">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            m.confidence >= 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {m.confidence >= 1 ? 'exact' : `${Math.round(m.confidence * 100)}% guess`}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {Object.entries(preview.skipped).map(([reason, n]) => (
                    <tr key={reason}>
                      <td className="px-3 py-1.5 text-red-600" colSpan={2}>
                        {n} row(s) skipped — {reason}
                      </td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {Object.keys(preview.categoryCounts).length > 0 && (
            <p className="text-xs text-gray-500">
              Failure mix:{' '}
              {Object.entries(preview.categoryCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([cat, n]) => `${cat} (${n})`)
                .join(' · ')}
            </p>
          )}

          <button
            onClick={ingest}
            disabled={busy !== null || preview.failureCount === 0}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy === 'ingest'
              ? `Running AI recovery pipeline on ${preview.failureCount.toLocaleString()} failures…`
              : preview.failureCount === 0
                ? 'No failed payments found in this file'
                : `⚡ Recover ${preview.failureCount.toLocaleString()} failed payments (${inr(Math.round(preview.estimatedAtRiskInr * 100))})`}
          </button>
          <p className="text-center text-[11px] text-gray-400">
            Processing runs diagnose → ML predict → policy decision → action → verification for every row.
          </p>
        </div>
      )}

      {/* Ingested result */}
      {preview?.ingested && (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="font-semibold text-emerald-800">✅ Import complete — {preview.fileName}</h2>
          {preview.note && <p className="text-sm text-emerald-700">{preview.note}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Processed events" value={(preview.processed ?? 0).toLocaleString()} tone="green" />
            <Kpi label="Recovery cases" value={(preview.casesCreated ?? 0).toLocaleString()} tone="green" />
            <Kpi label="Actions decided" value={(preview.actionsCreated ?? 0).toLocaleString()} tone="green" />
            <Kpi
              label="Pipeline errors"
              value={(preview.pipelineErrors ?? 0).toLocaleString()}
              tone={preview.pipelineErrors ? 'red' : undefined}
            />
          </div>
          <div className="flex gap-2 pt-1">
            <a href="/dashboard" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500">
              View dashboard
            </a>
            <a href="/cases" className="rounded-lg border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100">
              Open recovery cases
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }) {
  const color =
    tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
    </div>
  );
}

function TemplateDownload({ name, headers, sample }: { name: string; headers: string; sample: string }) {
  function download() {
    const csv = `${headers}\n${sample}\n${sample.replace(/pay_|cs_|INV-|cust@/g, (m) => m + '2')}`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `revenuepulse-${name}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button
      onClick={download}
      className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100"
    >
      Download {name} template
    </button>
  );
}
