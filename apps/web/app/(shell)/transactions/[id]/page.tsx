'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Inbox, Loader2 } from 'lucide-react';
import { PageHeader, EmptyState } from '../../../../components/ui/states';
import { Badge } from '../../../../components/ui/badge';
import { inr } from '../../../../lib/ui';

interface TxDetail {
  id: string;
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  paymentMethodDetails?: unknown;
  failureCode?: string | null;
  failureCategory?: string | null;
  failureMessage?: string | null;
  occurredAt: string;
  createdAt: string;
  webhookEventId?: string | null;
  rawEventRef?: string | null;
  cases: {
    id: string;
    ref?: string | null;
    status: string;
    amountAtRisk: number;
    priority: number;
    createdAt: string;
    refunds: { id: string; amount: number; status: string; createdAt: string }[];
  }[];
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  captured: 'success',
  authorized: 'warning',
  pending: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export default function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [tx, setTx] = useState<TxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/transactions/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('not found');
        const j = await r.json();
        setTx(j.data);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/transactions"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 transition hover:text-accent-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All transactions
      </Link>

      {loading && (
        <div className="flex items-center gap-2 py-16 text-sm text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
          Transaction not found or you do not have access to it.
        </div>
      )}

      {!loading && !error && tx && (
        <div className="space-y-4">
          <PageHeader
            title={tx.providerTransactionId}
            subtitle={
              <>
                <Badge tone={STATUS_TONE[tx.status] ?? 'neutral'}>{tx.status}</Badge>
                <span className="ml-2 text-sm capitalize text-ink-2">{tx.paymentMethod ?? '—'}</span>
              </>
            }
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-edge bg-surface p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Amount</p>
              <p className="mt-1 text-2xl font-bold text-ink">{inr(tx.amount)}</p>
              <p className="mt-1 text-xs text-ink-3">{tx.currency}</p>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Failure detail</p>
              <p className="mt-1 text-sm capitalize text-ink">
                {tx.failureCategory ? tx.failureCategory.replace(/_/g, ' ') : 'No failure recorded'}
              </p>
              {tx.failureCode && (
                <p className="mt-0.5 font-mono text-xs text-ink-3">{tx.failureCode}</p>
              )}
              {tx.failureMessage && <p className="mt-1 text-xs text-ink-2">{tx.failureMessage}</p>}
            </div>
          </div>

          {tx.cases.length > 0 && (
            <div className="rounded-xl border border-edge bg-surface p-5">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">
                Recovery case
              </p>
              {tx.cases.map((c) => (
                <Link
                  key={c.id}
                  href={`/cases/${c.id}`}
                  className="block rounded-lg border border-edge bg-surface-2 p-4 transition hover:border-accent"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-accent">
                      {c.ref ?? c.id.slice(-6)}
                    </span>
                    <Badge tone="neutral">{c.status.replace(/_/g, ' ')}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-ink">
                    {inr(c.amountAtRisk)} at risk · priority {c.priority.toFixed(2)}
                  </p>
                  {c.refunds.length > 0 && (
                    <p className="mt-2 text-xs text-ink-3">
                      {c.refunds.length} refund{c.refunds.length === 1 ? '' : 's'} on record
                    </p>
                  )}
                </Link>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-edge bg-surface p-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Metadata</p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-3">Occurred</dt>
                <dd className="text-ink">{new Date(tx.occurredAt).toLocaleString('en-IN')}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Persisted</dt>
                <dd className="text-ink">{new Date(tx.createdAt).toLocaleString('en-IN')}</dd>
              </div>
              {tx.rawEventRef && (
                <div>
                  <dt className="text-xs text-ink-3">Event ref</dt>
                  <dd className="font-mono text-xs text-ink-2">{tx.rawEventRef}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}

      {!loading && !error && !tx && (
        <EmptyState icon={Inbox} title="Nothing here" />
      )}
    </div>
  );
}
