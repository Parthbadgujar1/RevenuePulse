'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ShieldAlert } from 'lucide-react';
import { Badge } from './ui/badge';
import { SectionTitle, EmptyState, SkeletonList } from './ui/states';
import { timeAgo } from '../lib/ui';

interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  createdAt: string;
}

interface AuditResponse {
  success?: boolean;
  data?: AuditEntry[];
  actions?: string[];
  pagination?: { page: number; total: number; totalPages: number };
}

const ACTOR_TONE: Record<string, 'purple' | 'success' | 'neutral'> = {
  user: 'purple',
  agent: 'success',
  system: 'neutral',
};

export function AuditLogViewer() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [act, setAct] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '40' });
      if (act) params.set('action', act);
      const res = await fetch(`/api/admin/audit-logs?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const j = (await res.json()) as AuditResponse;
      setRows(j.data ?? []);
      setActions(j.actions ?? []);
      setTotalPages(j.pagination?.totalPages ?? 1);
      setTotal(j.pagination?.total ?? 0);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, act]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
        <ShieldAlert className="h-4 w-4" aria-hidden /> You do not have permission to view the audit log.
      </div>
    );
  }

  return (
    <div>
      <SectionTitle hint={total ? `${total} events` : undefined}>Audit trail</SectionTitle>

      <select
        value={act}
        onChange={(e) => {
          setAct(e.target.value);
          setPage(1);
        }}
        className="mb-3 h-10 rounded-lg border border-edge bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
      >
        <option value="">All actions</option>
        {actions.map((a) => (
          <option key={a} value={a}>
            {a.replace(/_/g, ' ')}
          </option>
        ))}
      </select>

      {loading ? (
        <SkeletonList rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState title="No audit events" message="Actions will appear here as the pipeline runs." />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-edge bg-surface shadow-sm">
            <ul className="divide-y divide-edge">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <Badge tone={ACTOR_TONE[r.actorType] ?? 'neutral'}>{r.actorType}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{r.action.replace(/_/g, ' ')}</p>
                    <p className="mt-0.5 truncate text-xs text-ink-3">
                      {r.reason ?? `${r.entityType} ${r.entityId}`}
                      {r.entityType ? ` · ${r.entityType} ${r.entityId.slice(0, 8)}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm">
            <p className="text-xs text-ink-3">
              {total} events · page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-edge bg-surface px-3 text-xs text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-edge bg-surface px-3 text-xs text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
              >
                Next <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
