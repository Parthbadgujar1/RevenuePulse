import type { ReactNode } from 'react';

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'purple' | 'orange' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-success/10 text-success-ink border-success/30',
  danger: 'bg-danger/10 text-danger-ink border-danger/30',
  warning: 'bg-warning/10 text-warning-ink border-warning/30',
  info: 'bg-info/10 text-info-ink border-info/30',
  purple: 'bg-purple/10 text-purple-ink border-purple/30',
  orange: 'bg-orange/10 text-orange-ink border-orange/30',
  neutral: 'bg-surface-2 text-ink-2 border-edge',
};

export function Badge({
  tone = 'neutral',
  children,
  dot,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Maps the pipeline case-status strings to a tone, via lib/ui STATUS_TONES. */
export function StatusBadge({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case 'RECOVERED':
        return 'success' as const;
      case 'DETECTED':
      case 'FAILED':
        return 'danger' as const;
      case 'EVALUATED':
        return 'info' as const;
      case 'ACTION_PENDING':
      case 'OUTCOME_PENDING':
        return 'warning' as const;
      case 'RECOVERY_IN_PROGRESS':
        return 'purple' as const;
      default:
        return 'neutral' as const;
    }
  })();

  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}