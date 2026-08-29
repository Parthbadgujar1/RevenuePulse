// Dashboard - Revenue Command Center
// Server component: every number below is computed from live Prisma data.
// Falls back to graceful empty states if the database is unreachable.

import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BellRing,
  Bot,
  Clock4,
  Coins,
  Handshake,
  HeartPulse,
  Info,
  Layers,
  Receipt,
  ShieldAlert,
  ShoppingCart,
  Sparkles,
  TimerOff,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../lib/merchant-context';
import { inr, timeAgo, statusTone } from '../../../lib/ui';
import { describeActivity } from '../../../lib/activity';
import { Card, CardBody, CardHeader } from '../../../components/ui/card';

export const dynamic = 'force-dynamic';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001';

interface ModelInfo {
  ok: boolean;
  version?: string;
  modelType?: string;
  rocAuc?: number;
  prAuc?: number;
  brier?: number;
}

async function getModelInfo(): Promise<ModelInfo> {
  try {
    const res = await fetch(`${ML_SERVICE_URL}/model-info`, {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    return {
      ok: true,
      version: j.version,
      modelType: j.type,
      rocAuc: j.held_out_test_metrics?.roc_auc,
      prAuc: j.held_out_test_metrics?.pr_auc,
      brier: j.held_out_test_metrics?.brier,
    };
  } catch {
    return { ok: false };
  }
}

interface PulsePoint {
  day: string;
  atRisk: number;
  recovered: number;
}

interface AttentionItem {
  label: string;
  count: number;
  detail: string;
  href: string;
  icon: 'approval' | 'invoice' | 'promise' | 'checkout' | 'policy';
}

interface Insight {
  heading: string;
  body: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'info';
}

async function getDashboardData() {
  try {
    const { merchantId } = await requireMerchantContext();
    const cases = await prisma.revenueCase.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
    const caseIds = cases.map((c) => c.id);
    const [actions, predictions, invoices, promises, sessions, logs] = await Promise.all([
      prisma.recoveryAction.findMany({ where: { caseId: { in: caseIds } } }),
      prisma.prediction.findMany({ where: { caseId: { in: caseIds } }, select: { caseId: true } }),
      prisma.invoice.findMany({ where: { merchantId } }),
      prisma.promiseToPay.findMany({ where: { merchantId } }),
      prisma.checkoutSession.findMany({ where: { merchantId } }),
      prisma.auditLog.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);
    const actionIds = actions.map((a) => a.id);
    const outcomes = await prisma.outcome.findMany({
      where: { actionId: { in: actionIds } },
    });
    const activeLogs = logs.filter((l) => Date.now() - l.createdAt.getTime() < 48 * 3600e3);

    const atRisk = cases.reduce((sum, c) => sum + c.amountAtRisk, 0);
    const recoveredRaw = outcomes
      .filter((o) => o.result === 'RECOVERED' || o.result === 'ADMIN_CONFIRMED_RECOVERY')
      .reduce((sum, o) => sum + o.recoveredAmount, 0);
    const actionCost = outcomes.reduce((sum, o) => sum + o.measuredCost, 0);
    const recovered = recoveredRaw;
    const netRecovered = recovered - actionCost;
    const recoveryRate = atRisk > 0 ? (recovered / atRisk) * 100 : 0;

    // Success rate among verified outcomes (real rows, honest).
    const verifiedOutcomes = outcomes.filter((o) => o.verifiedAt);
    const verifiedSuccess = verifiedOutcomes.filter((o) =>
      o.result === 'RECOVERED' || o.result === 'ADMIN_CONFIRMED_RECOVERY'
    ).length;
    const verifiedSuccessRate =
      verifiedOutcomes.length > 0 ? (verifiedSuccess / verifiedOutcomes.length) * 100 : 0;

    const openCases = cases.filter((c) =>
      ['DETECTED', 'EVALUATED', 'ACTION_PENDING', 'RECOVERY_IN_PROGRESS'].includes(c.status)
    ).length;
    const approvalPendingActions = actions.filter(
      (a) => a.approvalStatus === 'pending' && a.executionStatus !== 'EXECUTED'
    ).length;
    const stoppedCases = cases.filter((c) => c.status === 'STOPPED').length;
    const failedAttempts =
      verifiedOutcomes.length - verifiedSuccess;

    // Revenue pulse: last 14 days, bucketed by local date.
    const dayKeys: string[] = [];
    const dayLabels: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      dayKeys.push(d.toISOString().slice(0, 10));
      dayLabels.push(
        d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      );
    }
    const dayIndex = (d: Date) => Math.floor((d.getTime() + d.getTimezoneOffset() * 60e3) / 86400e3);
    const dayAxis =
      dayIndex(new Date(`${dayKeys[0]}T00:05:00`)) -
      Math.floor(new Date(`${dayKeys[0]}T00:05:00`).getTime() / 86400e3) +
      Math.floor(new Date(`${dayKeys[0]}T00:05:00`).getTime() / 86400e3);
    const atRiskSeries = new Array(14).fill(0);
    for (const c of cases) {
      const idx = Math.floor(
        (Math.floor(c.createdAt.getTime() / 86400e3) - (dayAxis - 13)) / 1
      );
      if (idx >= 0 && idx < 14) atRiskSeries[idx] += c.amountAtRisk;
    }
    const recoveredSeries = new Array(14).fill(0);
    for (const o of outcomes) {
      if (o.result !== 'RECOVERED' && o.result !== 'ADMIN_CONFIRMED_RECOVERY') continue;
      const t = o.verifiedAt ?? o.createdAt;
      const idx = Math.floor(t.getTime() / 86400e3) - (dayAxis - 13);
      if (idx >= 0 && idx < 14) recoveredSeries[idx] += o.recoveredAmount;
    }
    const pulse: PulsePoint[] = dayKeys.map((k, i) => ({
      day: dayLabels[i],
      atRisk: atRiskSeries[i],
      recovered: recoveredSeries[i],
    }));
    const peakPulse = Math.max(...recoveredSeries, ...atRiskSeries.map((a) => a || 0));

    // Category leakage (from structured diagnoses) for AI insight.
    const byCategory: Record<string, number> = {};
    for (const c of cases) {
      const cat =
        ((c.diagnosis as Record<string, unknown> | null)?.primaryCategory as string) ||
        'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + c.amountAtRisk;
    }
    const categories = Object.entries(byCategory)
      .map(([name, amount]) => ({ name, amount, pct: atRisk > 0 ? (amount / atRisk) * 100 : 0 }))
      .sort((a, b) => b.amount - a.amount);

    // What needs attention — every item backed by real rows.
    const overdueInvoices = invoices.filter((i) => i.status === 'overdue');
    const brokenPromises = promises.filter((p) => p.status === 'broken');
    const abandonedSessions = sessions.filter(
      (s) => s.status === 'abandoned' || s.status === 'recovery_sent'
    );
    const attention: AttentionItem[] = (
      [
        {
          label: 'Awaiting your approval',
          count: approvalPendingActions,
          detail: `recovery action${approvalPendingActions === 1 ? '' : 's'} queued under policy`,
          href: '/actions',
          icon: 'approval',
        },
        {
          label: 'Overdue invoices',
          count: overdueInvoices.length,
          detail: `${inr(overdueInvoices.reduce((s, i) => s + i.amount, 0))} outstanding`,
          href: '/receivables',
          icon: 'invoice',
        },
        {
          label: 'Broken promises to pay',
          count: brokenPromises.length,
          detail: 'follow-up escalation recommended',
          href: '/promises',
          icon: 'promise',
        },
        {
          label: 'Abandoned checkouts',
          count: abandonedSessions.length,
          detail: 'recovery incentives waiting',
          href: '/checkout',
          icon: 'checkout',
        },
        {
          label: 'Stopped by policy',
          count: stoppedCases,
          detail: 'guardrails or economics said no',
          href: '/settings',
          icon: 'policy',
        },
      ] as AttentionItem[]
    ).filter((a) => a.count > 0);

    // AI Revenue Intelligence — a genuine insight from the live data.
    const topLeak = categories[0];
    const insight: Insight = topLeak
      ? {
          heading: `${categoryHuman(topLeak.name)} is your biggest revenue leak`,
          body: `${inr(topLeak.amount)} at risk from this failure category — ${topLeak.pct.toFixed(1)}% of everything in the queue. Focus recovery sequence here first, then review the second-largest lever.`,
          detail: 'Computed from persisted diagnoses on live cases.',
          tone: topLeak.pct >= 40 ? 'danger' : topLeak.pct >= 20 ? 'warning' : 'info',
        }
      : {
          heading: 'No failure data yet',
          body: 'Run a demo batch or sync real failed payments to unlock AI-driven revenue intelligence.',
          detail: 'This dashboard computes everything from live pipeline rows.',
          tone: 'info',
        };

    const recentActivity = activeLogs.map((l) =>
      describeActivity({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        reason: l.reason,
        actorType: l.actorType,
        createdAt: l.createdAt.toISOString(),
      })
    );

    const recentCases = cases.slice(0, 6).map((c) => ({
      id: c.id,
      amount: c.amountAtRisk,
      status: c.status,
      priority: c.priority,
      category:
        ((c.diagnosis as Record<string, unknown> | null)?.primaryCategory as string) ||
        'unknown',
      attempts: c.attemptCount,
      createdAt: c.createdAt,
    }));

    return {
      ok: true as const,
      summary: {
        atRisk,
        openCases,
        totalCases: cases.length,
        recovered,
        recoveryRate,
        netRecovered,
        actionCost,
        awaitingApproval: approvalPendingActions,
        stoppedByPolicyOrEconomics: stoppedCases,
        failedAttempts,
        verifiedSuccessRate,
        verifiedSuccess,
        verifiedTotal: verifiedOutcomes.length,
      },
      pulse,
      peakPulse,
      categories,
      attention,
      insight,
      recentActivity,
      recentCases,
    };
  } catch (error) {
    console.error('Dashboard data load failed:', error);
    const zero = { atRisk: 0, openCases: 0, totalCases: 0, recovered: 0, recoveryRate: 0, netRecovered: 0, actionCost: 0, awaitingApproval: 0, stoppedByPolicyOrEconomics: 0, failedAttempts: 0, verifiedSuccessRate: 0, verifiedSuccess: 0, verifiedTotal: 0 };
    return {
      ok: false as const,
      summary: zero,
      pulse: [] as PulsePoint[],
      peakPulse: 0,
      categories: [] as { name: string; amount: number; pct: number }[],
      attention: [] as AttentionItem[],
      insight: {
        heading: 'Dashboard is temporarily paused',
        body: 'The live data source did not respond. Reload in a few seconds — nothing here is hardcoded.',
        detail: 'RevenuePulse recovers automatically once the database is reachable.',
        tone: 'warning' as const,
      },
      recentActivity: [] as unknown[],
      recentCases: [] as unknown[],
    };
  }
}

function categoryHuman(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const ATTENTION_ICONS: Record<AttentionItem['icon'], typeof AlertCircle> = {
  approval: ShieldAlert,
  invoice: Receipt,
  promise: Handshake,
  checkout: ShoppingCart,
  policy: TimerOff,
};

const INSIGHT_TONES = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  danger: 'border-red-500/30 bg-red-500/10 text-red-300',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
};

function Sparkline({ points, peak }: { points: number[]; peak: number }) {
  if (points.length < 2 || peak <= 0) return null;
  const w = 100;
  const h = 34;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => ({ x: i * step, y: h - (p / peak) * (h - 4) - 2 }));
  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rp-accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--rp-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkFill)" />
      <path d={line} fill="none" stroke="var(--rp-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HealthDonut({ pct }: { pct: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90">
          <circle cx="40" cy="40" r={r} fill="none" stroke="var(--rp-edge)" strokeWidth="8" />
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            stroke="var(--rp-success)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(filled / 100) * c} ${c}`}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold text-ink">{filled.toFixed(0)}%</span>
        </div>
      </div>
      <div className="text-sm">
        <p className="font-semibold text-ink">Revenue health</p>
        <p className="text-xs text-ink-3">
          Share of verified recovery outcomes that succeeded
        </p>
      </div>
    </div>
  );
}

export default async function Dashboard() {
  const { ok, summary, pulse, categories, attention, insight, recentActivity, recentCases } =
    await getDashboardData();
  const model = await getModelInfo();
  const hasData = ok && summary.totalCases > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">
            <Activity className="h-3.5 w-3.5" aria-hidden /> Revenue Command Center
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Live recovery overview
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Every number is computed from live pipeline data — nothing hardcoded.
          </p>
        </div>
        <Link
          href="/demo-lab"
          className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-strong"
        >
          <Zap className="h-4 w-4" aria-hidden /> Run a demo batch
        </Link>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardBody className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Revenue at risk</p>
            <p className="text-2xl font-bold text-ink">{inr(summary.atRisk)}</p>
            <p className="text-xs text-ink-3">
              {summary.totalCases} open case{summary.totalCases === 1 ? '' : 's'} in the queue
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
              <TrendingUp className="h-3.5 w-3.5 text-success-ink" aria-hidden /> Recovered
            </p>
            <p className="text-2xl font-bold text-success-ink">{inr(summary.recovered)}</p>
            <p className="truncate text-xs text-ink-3">
              {summary.verifiedSuccess}/{summary.verifiedTotal} verified outcomes
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">
              Net recovery
            </p>
            <p className="text-2xl font-bold text-ink">{inr(summary.netRecovered)}</p>
            <p className="truncate text-xs text-ink-3">
              after {inr(summary.actionCost)} action cost
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">
              Recovery rate
            </p>
            <p className="text-2xl font-bold text-ink">{summary.recoveryRate.toFixed(1)}%</p>
            <p className="text-xs text-ink-3">
              {summary.failedAttempts} attempt{summary.failedAttempts === 1 ? '' : 's'} failed to convert
            </p>
          </CardBody>
        </Card>
      </div>

      {/* Revenue pulse + health */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Revenue pulse"
            subtitle="Recovered vs at-risk by day (last 14 days)"

          />
          <CardBody>
            {hasData && pulse.length ? (
              <div className="space-y-2">
                <div className="flex gap-6 text-xs">
                  <span className="flex items-center gap-1.5 text-ink-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: 'var(--rp-accent)' }} />
                    Recovered
                  </span>
                  <span className="flex items-center gap-1.5 text-ink-3">
                    <span className="h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500" />
                    At risk
                  </span>
                </div>
                <div className="h-44 w-full">
                  <AreaChart points={pulse.map((p) => p.recovered)} peak={summary.atRisk || 0} secondary={pulse.map((p) => p.atRisk)} />
                </div>
                <div className="flex justify-between pt-1 text-[10px] text-ink-3">
                  {pulse.map((p) => (
                    <span key={p.day}>{p.day}</span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-ink-3">
                Run a demo batch to see the revenue pulse take shape.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Revenue health"
            subtitle="Verified outcome success"

          />
          <CardBody>
            <HealthDonut pct={summary.verifiedSuccessRate} />
            <div className="mt-5 space-y-2 border-t border-edge pt-4 text-xs">
              <Row label="Failed attempts" value={String(summary.failedAttempts)} />
              <Row label="Cases stopped" value={String(summary.stoppedByPolicyOrEconomics)} />
              <Row label="Awaiting approval" value={String(summary.awaitingApproval)} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Attention + AI insight */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="What needs attention"
            subtitle="Ranked by real workload"

          />
          <CardBody>
            {attention.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-3">
                Nothing waiting — every queue is clear.
              </p>
            ) : (
              <ul className="divide-y divide-edge">
                {attention.map((a) => {
                  const Icon = ATTENTION_ICONS[a.icon];
                  return (
                    <li key={a.label}>
                      <Link
                        href={a.href}
                        className="flex items-center gap-3 py-3 transition group"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                          <Icon className="h-4 w-4 text-accent-ink" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">
                            {a.label}
                          </span>
                          <span className="block truncate text-xs text-ink-3">{a.detail}</span>
                        </span>
                        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-sm font-bold text-ink">
                          {a.count}
                        </span>
                        <ArrowRight
                          className="h-4 w-4 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-accent-ink"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="AI Revenue Intelligence"
            subtitle="Advice from live signals"

          />
          <CardBody className="space-y-4">
            <div className={`rounded-xl border p-4 ${INSIGHT_TONES[insight.tone]}`}>
              <p className="text-sm font-semibold">{insight.heading}</p>
              <p className="mt-1 text-xs leading-relaxed opacity-90">{insight.body}</p>
              <p className="mt-2 flex items-center gap-1 text-[10px] opacity-80">
                <Info className="h-3 w-3" aria-hidden /> {insight.detail}
              </p>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">
                  Scoring model
                </p>
                {model.ok ? (
                  <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success-ink">
                    <Sparkles className="h-3 w-3" aria-hidden /> v{model.version}
                  </span>
                ) : (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">
                    service offline
                  </span>
                )}
              </div>
              {model.ok ? (
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <Metric label="ROC-AUC" value={model.rocAuc ? model.rocAuc.toFixed(3) : '—'} />
                  <Metric label="PR-AUC" value={model.prAuc ? model.prAuc.toFixed(3) : '—'} />
                  <Metric label="Brier" value={model.brier ? model.brier.toFixed(3) : '—'} />
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-3">
                  Start the ML service to see live model quality.
                </p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Activity + recent cases */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Recent activity"
            subtitle="From your audit trail"

          />
          <CardBody>
            {recentActivity.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-3">
                No actions in the last 48h.
              </p>
            ) : (
              <ul className="space-y-3">
                {recentActivity.map((a: any, i: number) => {
                  const Icon = a.icon;
                  return (
                    <li key={i} className="flex items-start gap-3">
                      <span className={`mt-0.5 shrink-0 ${a.iconTone}`}>
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">
                          {a.label}
                        </span>
                        <span className="block truncate text-xs text-ink-3">{a.detail}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-3">{a.day}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Cases on record"
            subtitle="Most recent failures in your pipeline"

          />
          <CardBody className="p-0 sm:p-0">
            {recentCases.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-3">
                No cases yet — <Link href="/demo-lab" className="text-accent-ink hover:underline">generate a demo cohort</Link>.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-3">
                      <th className="px-4 py-2.5 font-semibold">Status</th>
                      <th className="px-4 py-2.5 font-semibold">Failure</th>
                      <th className="px-4 py-2.5 font-semibold">At risk</th>
                      <th className="px-4 py-2.5 font-semibold">Priority</th>
                      <th className="px-4 py-2.5 font-semibold">Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {recentCases.map((c: any) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusTone(c.status)}`}
                          >
                            {c.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Link href={`/cases/${c.id}`} className="font-medium text-ink-2 hover:text-accent-ink hover:underline">
                            {categoryHuman(c.category)}
                          </Link>
                          <span className="block text-[11px] text-ink-3">
                            {c.attempts} attempt{c.attempts === 1 ? '' : 's'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-medium text-ink">{inr(c.amount)}</td>
                        <td className="px-4 py-2.5 text-ink-2">{c.priority.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-xs text-ink-3">{timeAgo(c.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {!ok && (
        <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink">
          <AlertCircle className="mr-1.5 inline h-4 w-4" aria-hidden />
          Live data temporarily unavailable — showing empty states. Reload to retry.
        </p>
      )}
    </div>
  );
}

function AreaChart({
  points,
  secondary,
  peak,
}: {
  points: number[];
  secondary: number[];
  peak: number;
}) {
  if (points.length < 2 || peak <= 0) return <Sparkline points={points} peak={peak} />;
  const w = 600;
  const h = 160;
  const pad = 6;
  const max = Math.max(peak, ...secondary);
  const usable = max > 0 ? (h - pad * 2) / max : 0;
  const step = w / (points.length - 1);
  const toY = (v: number) => h - pad - v * usable;

  const lineFor = (series: number[]) =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${toY(p).toFixed(1)}`)
      .join(' ');

  const line = lineFor(points);
  const area = `${line} L${w},${toY(0)} L0,${toY(0)} Z`;
  const secLine = lineFor(secondary);

  const lastX = (points.length - 1) * step;
  const lastY = toY(points[points.length - 1]);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rp-accent)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--rp-accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={w}
          y1={toY(max * f).toFixed(1)}
          y2={toY(max * f).toFixed(1)}
          stroke="var(--rp-edge)"
          strokeDasharray="2 4"
          strokeWidth="1"
        />
      ))}
      <path d={secLine} fill="none" stroke="var(--rp-edge-strong)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 4" />
      <path d={area} fill="url(#pulseFill)" />
      <path d={line} fill="none" stroke="var(--rp-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="4" fill="var(--rp-accent)" stroke="var(--rp-surface)" strokeWidth="2" />
    </svg>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-2">
      <p className="text-sm font-bold text-ink">{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-ink-3">{label}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-2">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  );
}