export function inr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function humanizeAction(type: string | null | undefined): string {
  switch ((type || '').toLowerCase()) {
    case 'retry_later':
      return 'Retry Later';
    case 'timed_reminder':
      return 'Timed Reminder';
    case 'payment_method_recovery':
      return 'Payment Method Update';
    case 'human_escalation':
      return 'Human Escalation';
    case 'checkout_recovery':
      return 'Checkout Recovery';
    case 'subscription_recovery':
      return 'Subscription Recovery';
    case 'do_nothing':
      return 'No Action (Stopped)';
    default:
      return type ? type.replace(/_/g, ' ') : '—';
  }
}

export function categoryLabel(cat: string | null | undefined): string {
  if (!cat) return 'Unknown';
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const STATUS_TONES: Record<string, string> = {
  DETECTED: 'bg-red-500/10 text-red-300 border-red-500/30',
  EVALUATED: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  ACTION_PENDING: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  RECOVERY_IN_PROGRESS: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  OUTCOME_PENDING: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
  RECOVERED: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-slate-800 text-slate-300 border-slate-700',
  STOPPED: 'bg-slate-800 text-slate-300 border-slate-700',
};

/** Source attribution chips — where each case came from. */
export const SOURCE_LABELS: Record<string, string> = {
  'demo-lab': '🟣 Demo Lab (simulated)',
  upload: '🟢 File Import',
  'razorpay-api': '🟠 Razorpay API Sync (live)',
  webhook: '🔵 Razorpay Webhook',
};

export function statusTone(status: string): string {
  return STATUS_TONES[status] || 'bg-slate-800 text-slate-300 border-slate-700';
}

export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
