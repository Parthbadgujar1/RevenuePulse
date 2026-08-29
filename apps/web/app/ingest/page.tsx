import type { Metadata } from 'next';
import AppNav from '../../components/app-nav';
import IngestForm from '../../components/ingest-form';

export const metadata: Metadata = { title: 'Data Import · RevenuePulse' };

const COLUMNS: { name: string; need: string; what: string }[] = [
  { name: 'payment_id', need: 'Recommended', what: 'Unique ID of the payment from your gateway (any unique reference works)' },
  { name: 'amount', need: 'Required', what: 'Transaction amount. Decimals or ₹ symbol are treated as rupees automatically' },
  { name: 'status', need: 'Optional', what: 'failed / declined / captured… Rows without a status are treated as failed' },
  { name: 'method', need: 'Optional', what: 'card, upi, netbanking, wallet…' },
  { name: 'error_code', need: 'Optional', what: "Gateway code like INSUFFICIENT_FUNDS or CARD_EXPIRED — drives the AI diagnosis" },
  { name: 'error_description', need: 'Optional', what: 'Free-text reason; used when no error code exists' },
  { name: 'created_at', need: 'Optional', what: 'When the payment happened (any common date format)' },
  { name: 'currency', need: 'Optional', what: 'Defaults to INR' },
  { name: 'email', need: 'Optional', what: 'Customer email for recovery outreach' },
  { name: 'phone', need: 'Optional', what: 'Customer phone for recovery outreach' },
];

export default function IngestPage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-bold text-slate-100">Import real payment data</h1>
        <p className="mt-1 mb-6 max-w-2xl text-sm text-slate-400">
          Bring your own failed payments — a CSV export, an Excel workbook, or even a PDF
          report. RevenuePulse auto-detects the columns and runs every failure through the
          same AI recovery pipeline as live webhooks.
        </p>

        {/* 1. Get the template */}
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-5">
          <h2 className="font-semibold text-indigo-300">Start with the sample file</h2>
          <p className="mt-1 text-sm text-indigo-300">
            Not sure which columns to include? Download the template, replace the example
            rows with your own data (keep the header row), and upload it. Only{' '}
            <strong>amount</strong> is strictly required — everything else improves the AI&rsquo;s
            accuracy.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="/samples/revenuepulse-sample-payments.csv"
              download
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              ⬇ Download sample CSV
            </a>
            <span className="self-center text-xs text-indigo-300">
              8 example rows · opens in Excel / Google Sheets
            </span>
          </div>
        </div>

        {/* 2. How it works */}
        <ol className="mb-6 mt-6 grid gap-3 text-sm md:grid-cols-3">
          <li className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <p className="font-semibold text-slate-100">1. Export your failures</p>
            <p className="text-slate-400">
              From Razorpay, your billing system, or a spreadsheet — any file with one row per payment.
            </p>
          </li>
          <li className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <p className="font-semibold text-slate-100">2. Upload &amp; check the preview</p>
            <p className="text-slate-400">
              We map your columns automatically and show you exactly what was detected before anything runs.
            </p>
          </li>
          <li className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <p className="font-semibold text-slate-100">3. Run the AI pipeline</p>
            <p className="text-slate-400">
              Every failure is diagnosed, scored, and given a recovery decision — money recovered shows up on the dashboard.
            </p>
          </li>
        </ol>

        <IngestForm />

        {/* 3. Column reference */}
        <details className="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-5">
          <summary className="cursor-pointer font-semibold text-slate-100">
            Column reference — what each field means
          </summary>
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2">Column</th>
                  <th className="px-4 py-2">Needed?</th>
                  <th className="px-4 py-2">What it is</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {COLUMNS.map((c) => (
                  <tr key={c.name}>
                    <td className="px-4 py-2 font-mono text-[13px] font-semibold text-slate-200">{c.name}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          c.need === 'Required'
                            ? 'bg-red-500/10 text-red-300'
                            : c.need === 'Recommended'
                              ? 'bg-amber-500/10 text-amber-300'
                              : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {c.need}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-400">{c.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Different header names? No problem — “Txn Amount”, “Payment Date”, “Reason” etc.
            are recognized automatically. You can also pick the amount unit (₹ vs paise) after upload.
          </p>
        </details>
      </main>
    </>
  );
}
