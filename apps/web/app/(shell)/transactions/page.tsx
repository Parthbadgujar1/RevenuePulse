'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Search, Inbox } from 'lucide-react';
import { PageHeader, EmptyState, SkeletonList } from '../../../components/ui/states';
import { Badge } from '../../../components/ui/badge';
import { inr, timeAgo } from '../../../lib/ui';

interface Tx {
  id: string;
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  failureCode?: string | null;
  failureCategory?: string | null;
  occurredAt: string;
  cases: { id: string; ref?: string | null; status: string }[];
}

interface TxResponse {
  success?: boolean;
  data: Tx[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  captured: 'success',
  authorized: 'warning',
  pending: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export default function TransactionsPage() {
  const [rows, setRows] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('occurredAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '25',
        sort,
        direction,
      });
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      const res = await fetch(`/api/transactions?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load');
      const json = (await res.json()) as TxResponse;
      setRows(json.data ?? []);
      setTotalPages(json.pagination?.totalPages ?? 1);
      setTotal(json.pagination?.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [page, search, status, sort, direction]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const toggleSort = (field: string) => {
    setPage(1);
    if (sort === field) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDirection('desc');
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Transactions"
        subtitle="Every payment that flowed through your pipeline — searchable, filterable, paginated from live data."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={submitSearch} className="flex min-w-56 flex-1 items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by ref, method, status, failure…"
              className="h-10 w-full rounded-lg border border-edge bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-strong"
          >
            Search
          </button>
        </form>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="h-10 rounded-lg border border-edge bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="captured">Captured</option>
          <option value="authorized">Authorized</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {loading && <SkeletonList rows={6} />}

      {!loading && error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
          Could not load transactions.
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No transactions match"
          message="Adjust your filters, or run a demo batch to generate payment events."
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-edge bg-surface shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="px-4 py-3 font-semibold">Reference</th>
                  <th
                    className="cursor-pointer px-4 py-3 font-semibold hover:text-ink"
                    onClick={() => toggleSort('occurredAt')}
                  >
                    Date
                    {sort === 'occurredAt' && (direction === 'desc' ? ' ↓' : ' ↑')}
                  </th>
                  <th
                    className="cursor-pointer px-4 py-3 font-semibold hover:text-ink"
                    onClick={() => toggleSort('amount')}
                  >
                    Amount
                    {sort === 'amount' && (direction === 'desc' ? ' ↓' : ' ↑')}
                  </th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Method</th>
                  <th className="px-4 py-3 font-semibold">Failure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {rows.map((t) => (
                  <tr key={t.id} className="transition hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <Link
                        href={`/transactions/${t.id}`}
                        className="font-mono text-xs font-semibold text-accent hover:underline"
                      >
                        {t.providerTransactionId}
                      </Link>
                      {t.cases.length > 0 && (
                        <span className="ml-2 text-[11px] text-ink-3">
                          case {t.cases[0].ref ?? t.cases[0].id.slice(-6)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-2">{timeAgo(t.occurredAt)}</td>
                    <td className="px-4 py-3 font-medium text-ink">{inr(t.amount)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{t.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs capitalize text-ink-2">{t.paymentMethod ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-ink-3">
                      {t.failureCategory
                        ? t.failureCategory.replace(/_/g, ' ')
                        : t.failureCode ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm">
            <p className="text-xs text-ink-3">
              {total} transaction{total === 1 ? '' : 's'} · page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-edge bg-surface px-3 text-sm text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden /> Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-edge bg-surface px-3 text-sm text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
              >
                Next <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
