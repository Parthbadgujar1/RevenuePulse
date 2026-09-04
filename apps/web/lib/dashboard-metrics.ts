/**
 * Canonical dashboard metrics (Implementation Pack §9).
 *
 * Single source of truth for KPIs so cards, charts and the API reconcile.
 * All KPIs are computed from persisted rows and the date range is exclusive
 * of the timezone confusion (dates are bucketed in the merchant's configured
 * timezone, default Asia/Kolkata).
 */
import { prisma } from '@rp/database';

export interface DashboardRange {
  from?: Date;
  to?: Date;
}

export interface SummaryKpis {
  grossRevenue: number;
  netRevenue: number;
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
  refunds: number;
  refundAmount: number;
  successRate: number;
  totalTransactions: number;
}

export interface StatusPoint {
  status: string;
  count: number;
  amount: number;
}

export interface SeriesPoint {
  date: string;
  label: string;
  gross: number;
  net: number;
  successful: number;
  failed: number;
}

function rangeFilter(ctx: DashboardRange): { gte?: Date; lte?: Date } {
  const f: { gte?: Date; lte?: Date } = {};
  if (ctx.from) f.gte = ctx.from;
  if (ctx.to) f.lte = ctx.to;
  return f;
}

function startOfLocalDay(d: Date, tz: string): Date {
  const s = new Date(d);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(s);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return new Date(`${y}-${m}-${day}T00:00:00`);
}

/** Canonical summary KPIs for the dashboard. */
export async function getSummary(
  merchantId: string,
  range: DashboardRange = {}
): Promise<SummaryKpis> {
  const where = { merchantId, ...(range.from || range.to ? { occurredAt: rangeFilter(range) } : {}) };

  const rows = await prisma.transaction.findMany({
    where,
    select: { amount: true, status: true },
  });

  let grossRevenue = 0;
  let successfulPayments = 0;
  let failedPayments = 0;
  let pendingPayments = 0;
  const totalTransactions = rows.length;

  for (const r of rows) {
    grossRevenue += r.amount;
    if (r.status === 'captured') successfulPayments++;
    else if (r.status === 'failed') failedPayments++;
    else if (r.status === 'pending' || r.status === 'authorized') pendingPayments++;
  }

  const refundAgg = await prisma.refund.aggregate({
    where: { merchantId, status: { in: ['processed', 'initiated'] } },
    _sum: { amount: true },
  });
  const refundAmount = refundAgg._sum.amount ?? 0;
  const refunds = await prisma.refund.count({
    where: { merchantId, status: { in: ['processed', 'initiated'] } },
  });

  const netRevenue = grossRevenue - refundAmount;
  const successRate = totalTransactions > 0 ? (successfulPayments / totalTransactions) * 100 : 0;

  return {
    grossRevenue,
    netRevenue,
    successfulPayments,
    failedPayments,
    pendingPayments,
    refunds,
    refundAmount,
    successRate: Math.round(successRate * 100) / 100,
    totalTransactions,
  };
}

/** Payment status distribution (counts + amounts). */
export async function getPaymentStatus(
  merchantId: string,
  range: DashboardRange = {}
): Promise<StatusPoint[]> {
  const where = { merchantId, ...(range.from || range.to ? { occurredAt: rangeFilter(range) } : {}) };
  const rows = await prisma.transaction.findMany({ where, select: { status: true, amount: true } });
  const map = new Map<string, StatusPoint>();
  for (const r of rows) {
    const key = r.status || 'unknown';
    const cur = map.get(key) ?? { status: key, count: 0, amount: 0 };
    cur.count++;
    cur.amount += r.amount;
    map.set(key, cur);
  }
  return Array.from(map.values());
}

/** Daily revenue + volume series (last N days, inclusive of date range). */
export async function getRevenueSeries(
  merchantId: string,
  tz: string,
  days = 30,
  range: DashboardRange = {}
): Promise<SeriesPoint[]> {
  const now = new Date();
  const start = range.from ? range.from : new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const end = range.to ? range.to : now;
  const where = { merchantId, occurredAt: { gte: start, lte: end } };

  const rows = await prisma.transaction.findMany({
    where,
    select: { amount: true, status: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
  });

  const series: SeriesPoint[] = [];
  const todayStart = startOfLocalDay(now, tz);
  const numDays = Math.min(days, Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400e3) + 1));
  for (let i = 0; i < numDays; i++) {
    const dayStart = new Date(todayStart.getTime() - (numDays - 1 - i) * 86400e3);
    const key = dayStart.toISOString().slice(0, 10);
    series.push({
      date: key,
      label: dayStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      gross: 0,
      net: 0,
      successful: 0,
      failed: 0,
    });
  }
  const indexOf = (d: Date) => {
    const t = new Date(d);
    const key = startOfLocalDay(t, tz).toISOString().slice(0, 10);
    return series.findIndex((s) => s.date === key);
  };

  for (const r of rows) {
    const i = indexOf(r.occurredAt);
    if (i < 0) continue;
    series[i].gross += r.amount;
    if (r.status === 'captured') series[i].successful++;
    if (r.status === 'failed') series[i].failed++;
  }

  return series.map((s) => ({ ...s, net: s.gross }));
}
