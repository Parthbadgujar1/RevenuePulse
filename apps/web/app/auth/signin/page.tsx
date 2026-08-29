'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@revenuepulse.dev');
  const [password, setPassword] = useState('demo1234');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate(): string | null {
    if (!email.trim()) return 'Enter your email address.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'That email does not look valid.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setLoading(true);
    setError(null);

    const result = await signIn('credentials', {
      email: email.trim(),
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('Invalid email or password.');
      return;
    }

    router.push('/dashboard');
    router.refresh();
  }

  const inputCls =
    'mt-1 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 pl-10 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 transition';

  return (
    <main className="flex min-h-screen bg-bg">
      {/* Left brand panel */}
      <aside className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-accent lg:flex">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10" aria-hidden />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-white/10" aria-hidden />
        <div className="relative z-10 p-10">
          <p className="flex items-center gap-2 text-lg font-semibold text-white">
            <Activity className="h-6 w-6" aria-hidden />
            RevenuePulse
          </p>
        </div>
        <div className="relative z-10 p-10">
          <h2 className="max-w-md text-3xl font-bold leading-tight text-white">
            OBSERVE → UNDERSTAND → ACT
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-white/80">
            Every failed payment is diagnosed, scored by a recovery model, checked against your
            guardrails, and acted on within bounds — then the outcome is verified and fed back.
          </p>
          <div className="mt-8 grid max-w-md grid-cols-3 gap-4">
            {[
              ['44', 'ML features'],
              ['0.77', 'ROC-AUC'],
              ['Real', 'live data'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-xl bg-white/10 px-4 py-3">
                <p className="text-xl font-bold text-white">{v}</p>
                <p className="text-[11px] uppercase tracking-wider text-white/70">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Right form panel */}
      <section className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <p className="mb-1 flex items-center gap-2 text-lg font-semibold text-ink lg:hidden">
            <Activity className="h-5 w-5 text-accent-ink" aria-hidden />
            RevenuePulse
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Welcome back</h1>
          <p className="mt-1 text-sm text-ink-3">
            Sign in to your revenue command center.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-ink-2">
                Email
              </label>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
                  aria-hidden
                />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                  placeholder="you@merchant.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-ink-2">
                Password
              </label>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
                  aria-hidden
                />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputCls} pr-10`}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-ink-3 transition hover:text-ink"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger-ink"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <span
                    aria-hidden
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 rounded-xl border border-edge bg-surface p-3.5">
            <p className="text-xs font-semibold text-ink-2">Demo workspace</p>
            <p className="mt-0.5 font-mono text-xs text-ink-3">
              owner@revenuepulse.dev · demo1234
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}