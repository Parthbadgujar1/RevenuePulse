import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Bot,
  Eye,
  FileUp,
  Gauge,
  Plug,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';

const stats = [
  { value: '12–18%', label: 'of MRR lost to failed payments' },
  { value: '<1s', label: 'webhook to diagnosis latency' },
  { value: '3', label: 'recovery channels orchestrated' },
  { value: '100%', label: 'actions auditable end-to-end' },
];

const pipeline = [
  {
    icon: Eye,
    title: 'Observe',
    body: 'Every Razorpay webhook is actioned in under a second — diagnoses are written to an immutable audit trail.',
  },
  {
    icon: Bot,
    title: 'Understand',
    body: 'A calibrated recovery model scores each failure (44 features, honest held-out metrics) and determines expected net value.',
  },
  {
    icon: ShieldCheck,
    title: 'Act safely',
    body: 'Policy-checked, bounded interventions: retries, dunning, instrument nudges, checkout recovery — all inside your guardrails.',
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-bg">
      {/* Header */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
        <p className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
            <Activity className="h-5 w-5" aria-hidden />
          </span>
          Revenue<span className="text-accent-ink">Pulse</span>
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/auth/signin"
            className="rounded-xl border border-edge px-4 py-2 text-sm font-semibold text-ink-2 transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-strong"
          >
            Open dashboard <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute -top-40 left-1/2 h-[28rem] w-[40rem] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent-ink">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            AI Revenue Recovery Platform
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Stop losing recurring revenue to{' '}
            <span className="text-accent-ink">silent payment failures</span>.
          </h1>
          <p className="mt-6 max-w-2xl text-base text-ink-2 sm:text-lg">
            RevenuePulse watches every payment that fails, diagnoses why, predicts
            whether it can be recovered, and orchestrates the right intervention —
            under your merchant policies and fully audited.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/demo-lab"
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-strong"
            >
              <Zap className="h-4 w-4" aria-hidden /> Run 100-case demo
            </Link>
            <Link
              href="/integrations"
              className="inline-flex items-center gap-2 rounded-xl border border-edge bg-surface px-5 py-2.5 text-sm font-semibold text-ink transition hover:border-edge-strong hover:bg-surface-2"
            >
              <Plug className="h-4 w-4" aria-hidden /> Connect Razorpay API
            </Link>
            <Link
              href="/ingest"
              className="inline-flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-5 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/10"
            >
              <FileUp className="h-4 w-4" aria-hidden /> Import CSV / Excel / PDF
            </Link>
          </div>

          <dl className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="rounded-2xl border border-edge bg-surface p-5">
                <dt className="text-2xl font-bold text-accent-ink sm:text-3xl">{s.value}</dt>
                <dd className="mt-1 text-sm text-ink-3">{s.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Pipeline */}
      <section className="border-t border-edge bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">
            How it works
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Observe → Understand → Act
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {pipeline.map((s, i) => (
              <div key={s.title} className="relative rounded-2xl border border-edge bg-bg p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10">
                  <s.icon className="h-5 w-5 text-accent-ink" aria-hidden />
                </span>
                <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-ink-3">
                  Step {i + 1}
                </p>
                <h3 className="mt-1 text-lg font-semibold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-edge py-8 text-center text-sm text-ink-3">
        <p className="flex items-center justify-center gap-1.5">
          <Gauge className="h-4 w-4" aria-hidden />
          RevenuePulse — AI-powered revenue recovery, end to end
        </p>
      </footer>
    </main>
  );
}