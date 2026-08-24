import Link from "next/link";

const features = [
  {
    title: "Failure Diagnosis",
    description:
      "Every failed payment is categorized against a 40-code failure taxonomy in real time, separating permanent losses from recoverable revenue.",
  },
  {
    title: "AI Recovery Models",
    description:
      "A calibrated logistic-regression model (isotonic calibration, honest held-out metrics) scores each failed transaction for recovery probability and expected net value.",
  },
  {
    title: "Bounded Agent Actions",
    description:
      "An orchestrator drafts recovery actions — retries, dunning emails, instrument-upgrade nudges — gated by zod-validated tool schemas and merchant policy.",
  },
  {
    title: "Policy Engine",
    description:
      "Per-merchant guardrails enforce retry ceilings, quiet hours, spend limits, and approval thresholds before any customer-facing action fires.",
  },
];

const stats = [
  { value: "12–18%", label: "of MRR lost to failed payments" },
  { value: "<1s", label: "webhook to diagnosis latency" },
  { value: "3", label: "recovery channels orchestrated" },
  { value: "100%", label: "actions auditable end-to-end" },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-emerald-400">
            RevenuePulse
          </span>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          Open Dashboard
        </Link>
      </header>

      <section className="mx-auto max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-20">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          AI Revenue Recovery
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
          Stop losing recurring revenue to{" "}
          <span className="text-emerald-400">silent payment failures</span>.
        </h1>
        <p className="mt-6 max-w-2xl text-base text-slate-300 sm:text-lg">
          RevenuePulse watches every Razorpay webhook, diagnoses why each payment
          failed, predicts whether it can be recovered, and orchestrates the
          right intervention — under your merchants&apos; policies.
        </p>

        {/* Data-source onboarding */}
        <div className="mt-8">
          <p className="text-sm font-medium text-slate-400">Choose a data source to begin:</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link
              href="/demo-lab"
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
            >
              ▶ Run 100-Case Demo
            </Link>
            <Link
              href="/integrations"
              className="rounded-lg border border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-emerald-500 hover:text-emerald-400"
            >
              Connect Razorpay API
            </Link>
            <Link
              href="/ingest"
              className="rounded-lg border border-indigo-500/60 px-5 py-2.5 text-sm font-semibold text-indigo-300 transition hover:bg-indigo-500/10"
            >
              📥 Import CSV / Excel / PDF
            </Link>
            <Link
              href="/dashboard"
              className="rounded-lg border border-slate-800 px-5 py-2.5 text-sm font-medium text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
            >
              Open Dashboard
            </Link>
          </div>
        </div>

        <dl className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-slate-800 bg-slate-900 p-5"
            >
              <dt className="text-2xl font-bold text-emerald-400 sm:text-3xl">
                {s.value}
              </dt>
              <dd className="mt-1 text-sm text-slate-400">{s.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-slate-800 bg-slate-900 p-6"
            >
              <h2 className="text-lg font-semibold text-slate-100">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-800 py-8 text-center text-sm text-slate-500">
        RevenuePulse — simulation-first revenue recovery platform
      </footer>
    </main>
  );
}
