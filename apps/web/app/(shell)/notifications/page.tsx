'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  Inbox,
  Info,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { PageHeader, EmptyState, SkeletonList } from '../../../components/ui/states';
import { Badge } from '../../../components/ui/badge';
import { useToast } from '../../../components/ui/toast';
import { timeAgo } from '../../../lib/ui';

interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationResponse {
  success?: boolean;
  unread?: number;
  data: NotificationItem[];
  pagination?: { total: number; totalPages: number };
}

const SEVERITY_ICONS = {
  success: { Icon: Check, tone: 'text-success-ink' },
  warning: { Icon: TriangleAlert, tone: 'text-warning-ink' },
  danger: { Icon: ShieldAlert, tone: 'text-danger-ink' },
  info: { Icon: Info, tone: 'text-info-ink' },
} as const;

export default function NotificationsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const load = useCallback(
    async (unread = unreadOnly) => {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/notifications?unread=${unread}`);
        if (!res.ok) throw new Error('Failed to load');
        const json = (await res.json()) as NotificationResponse;
        setItems(json.data ?? []);
        setUnreadCount(json.unread ?? 0);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [unreadOnly],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: string) => {
    const res = await fetch(`/api/notifications/${id}/read`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      setItems((prev) => prev.filter((n) => n.id !== id));
      setUnreadCount((c) => Math.max(0, c - 1));
      toast('success', 'Marked as read');
    }
  };

  const markAllRead = async () => {
    await Promise.all(items.filter((n) => !n.readAt).map((n) => markRead(n.id)));
    void load(true);
  };

  const sev = (s: string): keyof typeof SEVERITY_ICONS =>
    (['success', 'warning', 'danger', 'info'] as const).includes(s as never)
      ? (s as keyof typeof SEVERITY_ICONS)
      : 'info';

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        subtitle="Alerts and events from your recovery pipeline."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setUnreadOnly((u) => !u)}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-edge bg-surface px-3 text-sm font-medium text-ink-2 transition hover:bg-surface-2"
            >
              <BellRing className="h-4 w-4" aria-hidden />
              {unreadOnly ? 'All notifications' : 'Unread only'}
            </button>
            {items.length > 0 && (
              <button
                onClick={markAllRead}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-edge bg-surface px-3 text-sm font-medium text-ink-2 transition hover:bg-surface-2"
              >
                <CheckCheck className="h-4 w-4" aria-hidden />
                Mark all read
              </button>
            )}
          </div>
        }
      />

      {loading && <SkeletonList rows={5} />}

      {!loading && error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
          Could not load notifications. Please try again.
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={Inbox}
          title={unreadOnly && unreadCount === 0 ? 'You are all caught up' : 'No notifications'}
          message={
            unreadOnly
              ? 'No unread notifications right now.'
              : 'Notifications appear here automatically as the recovery pipeline runs.'
          }
        />
      )}

      {!loading && !error && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((n) => {
            const { Icon, tone } = SEVERITY_ICONS[sev(n.severity)];
            return (
              <li
                key={n.id}
                className="flex items-start gap-3 rounded-xl border border-edge bg-surface p-4 shadow-sm"
              >
                <span className={`mt-0.5 shrink-0 ${tone}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{n.title}</p>
                    <Badge tone="neutral">{n.severity}</Badge>
                    {!n.readAt && <Badge tone="info" dot>new</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{n.message}</p>
                  <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
                    <Bell className="h-3 w-3" aria-hidden />
                    {timeAgo(n.createdAt)}
                    {n.entityType ? ` · ${n.entityType}` : ''}
                  </p>
                </div>
                {!n.readAt && (
                  <button
                    onClick={() => markRead(n.id)}
                    aria-label="Mark as read"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                  >
                    <Check className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
