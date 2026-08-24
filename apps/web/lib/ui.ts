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
  DETECTED: 'bg-red-100 text-red-700 border-red-300',
  EVALUATED: 'bg-blue-100 text-blue-700 border-blue-300',
  ACTION_PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  RECOVERY_IN_PROGRESS: 'bg-purple-100 text-purple-700 border-purple-300',
  OUTCOME_PENDING: 'bg-orange-100 text-orange-800 border-orange-300',
  RECOVERED: 'bg-green-100 text-green-700 border-green-300',
  FAILED: 'bg-gray-200 text-gray-700 border-gray-300',
  STOPPED: 'bg-gray-200 text-gray-700 border-gray-300',
};

/** Source attribution chips — where each case came from. */
export const SOURCE_LABELS: Record<string, string> = {
  'demo-lab': '🟣 Demo Lab (simulated)',
  upload: '🟢 File Import',
  'razorpay-api': '🟠 Razorpay API Sync (live)',
  webhook: '🔵 Razorpay Webhook',
};

export function statusTone(status: string): string {
  return STATUS_TONES[status] || 'bg-gray-100 text-gray-700 border-gray-300';
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
