'use client';

import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'success'
  | 'accent-outline';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-accent',
  secondary:
    'border border-edge bg-surface text-ink hover:bg-surface-2 hover:border-edge-strong disabled:opacity-50',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50',
  destructive:
    'bg-danger text-white hover:bg-danger-strong disabled:opacity-50',
  success:
    'bg-success text-on-accent hover:bg-success-hover disabled:opacity-50',
  'accent-outline':
    'border border-accent text-accent-ink hover:bg-accent/10 disabled:opacity-50',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-sm',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof SIZES;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = 'primary', size = 'md', loading, className, children, disabled, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={`inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className ?? ''}`}
        disabled={disabled || loading}
        {...rest}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {children}
      </button>
    );
  },
);