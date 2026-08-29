import { PackageOpen, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">
        {children}
      </h2>
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

export function EmptyState({
  icon: Icon = PackageOpen,
  title,
  message,
  action,
  actionLabel,
  onAction,
}: {
  icon?: typeof PackageOpen;
  title: string;
  message?: string;
  action?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-edge bg-surface px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-ink-3" aria-hidden />
      <h3 className="mt-3 text-sm font-semibold text-ink">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-xs text-ink-2">{message}</p>}
      {action ??
        (actionLabel &&
          onAction && (
            <Button variant="secondary" size="sm" className="mt-4" onClick={onAction}>
              <RotateCcw className="h-3.5 w-3.5" />
              {actionLabel}
            </Button>
          ))}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-danger/30 bg-danger/5 px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-danger-ink">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-xs text-ink-2">{message}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" />
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-lg bg-surface-2 ${className}`}
    />
  );
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}