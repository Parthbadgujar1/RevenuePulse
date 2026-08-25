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
        <h1 className="text-2xl font-bold text-gray-900">Import real payment data</h1>
        <p className="mt-1 mb-6 max-w-2xl text-sm text-gray-500">
          Bring your own failed payments — a CSV export, an Excel workbook, or even a PDF
          report. RevenuePulse auto-detects the columns and runs every failure through the
          same AI recovery pipeline as live webhooks.
        </p>

        {/* 1. Get the template */}
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
          <h2 className="font-semibold text-indigo-900">Start with the sample file</h2>
          <p className="mt-1 text-sm text-indigo-800">
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
            <span className="self-center text-xs text-indigo-700">
              8 example rows · opens in Excel / Google Sheets
            </span>
          </div>
        </div>

        {/* 2. How it works */}
        <ol className="mb-6 mt-6 grid gap-3 text-sm md:grid-cols-3">
          <li className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="font-semibold text-gray-900">1. Export your failures</p>
            <p className="text-gray-600">
              From Razorpay, your billing system, or a spreadsheet — any file with one row per payment.
            </p>
          </li>
          <li className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="font-semibold text-gray-900">2. Upload &amp; check the preview</p>
            <p className="text-gray-600">
              We map your columns automatically and show you exactly what was detected before anything runs.
            </p>
          </li>
          <li className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="font-semibold text-gray-900">3. Run the AI pipeline</p>
            <p className="text-gray-600">
              Every failure is diagnosed, scored, and given a recovery decision — money recovered shows up on the dashboard.
            </p>
          </li>
        </ol>

        <IngestForm />

        {/* 3. Column reference */}
        <details className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
          <summary className="cursor-pointer font-semibold text-gray-900">
            Column reference — what each field means
          </summary>
          <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Column</th>
                  <th className="px-4 py-2">Needed?</th>
                  <th className="px-4 py-2">What it is</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {COLUMNS.map((c) => (
                  <tr key={c.name}>
                    <td className="px-4 py-2 font-mono text-[13px] font-semibold text-gray-800">{c.name}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          c.need === 'Required'
                            ? 'bg-red-50 text-red-700'
                            : c.need === 'Recommended'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {c.need}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-600">{c.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Different header names? No problem — “Txn Amount”, “Payment Date”, “Reason” etc.
            are recognized automatically. You can also pick the amount unit (₹ vs paise) after upload.
          </p>
        </details>
      </main>
    </>
  );
}
