import type { ReactNode } from 'react';

export function Card({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-edge bg-surface shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-5 py-4">
      <div>
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}