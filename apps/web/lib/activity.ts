import {
  Brackets,
  CheckCircle2,
  CircleAlert,
  FileClock,
  Handshake,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

export interface ActivityItem {
  id: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  actorType?: string | null;
  createdAt: string;
}

export interface ActivityMeta {
  icon: LucideIcon;
  iconTone: string;
  label: string;
  detail: string;
  day: string;
  href?: string;
}

export function describeActivity(a: ActivityItem): ActivityMeta {
  const action = a.action || '';
  const day = a.createdAt ? timeAgo(new Date(a.createdAt)) : '';
  let icon: LucideIcon = Sparkles;
  let iconTone = 'text-info-ink';
  let label = action.replace(/_/g, ' ');
  let href: string | undefined;

  if (action.includes('recovered') || action.includes('recovery_outcome')) {
    icon = CheckCircle2;
    iconTone = 'text-success-ink';
    label =
      action.includes('failed') || /NOT_RECOVERED|not recovered/i.test(a.reason ?? '')
        ? 'Recovery not recovered'
        : 'Payment recovered';
  } else if (action.includes('executed') || action.includes('approve')) {
    icon = RotateCcw;
    iconTone = 'text-accent-ink';
    label = 'Recovery action executed';
  } else if (action.includes('failure_diagnosed')) {
    icon = CircleAlert;
    iconTone = 'text-danger-ink';
    label = 'Payment failure diagnosed';
  } else if (action.includes('chase') || action.includes('invoice')) {
    icon = FileClock;
    iconTone = 'text-orange-ink';
    label = 'Invoice reminder sent';
  } else if (action.includes('promise')) {
    icon = Handshake;
    iconTone = 'text-purple-ink';
    label = 'Promise to pay logged';
  } else if (action.includes('policy') || action.includes('guardrail') || action.includes('denied')) {
    icon = TriangleAlert;
    iconTone = 'text-warning-ink';
    label = 'Guardrail triggered';
  } else if (action.includes('case') || action.includes('export')) {
    icon = Brackets;
    iconTone = 'text-ink-2';
  }

  if (a.entityType?.includes('RevenueCase')) href = `/cases/${a.entityId}`;
  else if (a.entityType?.includes('Invoice')) href = '/receivables';
  else if (a.entityType?.includes('Promise')) href = '/promises';

  const detail = a.reason || label;

  return { icon, iconTone, label, detail, day, href };
}

export function timeAgo(date: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}