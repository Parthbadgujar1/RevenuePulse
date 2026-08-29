'use client';

import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  AlertTriangle,
  Bell,
  LogOut,
  Menu,
  Moon,
  Search,
  Sun,
  User,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { describeActivity, type ActivityItem } from '../../lib/activity';
import { useTheme } from '../theme-provider';
import { CommandPalette, useCommandPalette } from './command-palette';
import { titleForPath } from './nav-model';
import {
  Brand,
  CloseDrawerButton,
  CollapseButton,
  SideNav,
  SidebarFooter,
} from './sidebar';

interface Recent {
  items: ActivityItem[];
  unread: number;
}

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string;
  };
}) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const { open, setOpen } = useCommandPalette();

  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [activity, setActivity] = useState<Recent>({ items: [], unread: 0 });
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const profile = user ?? {};

  const loadActivity = useCallback(() => {
    fetch('/api/activity/recent')
      .then((r) => (r.ok ? r.json() : { items: [], unread: 0 }))
      .then((d) => setActivity(d))
      .catch(() => setActivity({ items: [], unread: 0 }));
  }, []);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    setMenuOpen(false);
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const doLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await signOut({ callbackUrl: '/auth/signin' });
    } catch {
      window.location.assign('/auth/signin');
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  }, []);

  const initials =
    profile.name?.split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase() ??
    'RP';

  const searchButton = (
    <button
      onClick={() => setOpen(true)}
      className="flex h-9 w-full max-w-72 items-center gap-2 rounded-lg border border-edge bg-surface px-3 text-xs text-ink-3 transition hover:border-edge-strong hover:text-ink-2"
      aria-label="Search (⌘K)"
    >
      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search RevenuePulse…</span>
      <kbd className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
        ⌘K
      </kbd>
    </button>
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-edge bg-surface transition-[width] duration-200 lg:flex ${
          collapsed ? 'w-[76px]' : 'w-64'
        }`}
      >
        <div className={`flex h-16 items-center gap-2 border-b border-edge px-4 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          <Brand collapsed={collapsed} />
          {!collapsed && <CollapseButton collapsed={false} onClick={() => setCollapsed(true)} />}
        </div>
        <SideNav collapsed={collapsed} />
        <SidebarFooter collapsed={collapsed} onLogout={() => setConfirmLogout(true)} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div
            className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-edge bg-surface"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
          >
            <div className="flex h-16 items-center justify-between border-b border-edge px-4">
              <Brand />
              <CloseDrawerButton onClick={() => setDrawerOpen(false)} />
            </div>
            <SideNav onNavigate={() => setDrawerOpen(false)} />
            <SidebarFooter onLogout={() => setConfirmLogout(true)} />
          </div>
        </div>
      )}

      {/* Logout confirmation */}
      {confirmLogout && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/45 px-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-title"
            className="w-full max-w-sm rounded-2xl border border-edge bg-elevated p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger/10">
                <LogOut className="h-4 w-4 text-danger-ink" aria-hidden />
              </span>
              <div>
                <h2 id="logout-title" className="text-sm font-semibold text-ink">
                  Log out of RevenuePulse?
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">
                  You will need to sign in again to access your dashboard.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmLogout(false)}
                className="h-9 rounded-lg border border-edge bg-surface px-4 text-sm font-medium text-ink transition hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                onClick={doLogout}
                disabled={loggingOut}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-white transition hover:bg-danger-strong disabled:opacity-60"
              >
                {loggingOut && (
                  <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                )}
                Log out
              </button>
            </div>
          </div>
        </div>
      )}

      <CommandPalette open={open} onClose={() => setOpen(false)} />

      {/* Content column */}
      <div className="flex min-h-screen flex-col lg:pl-64" style={collapsed ? { paddingLeft: '76px' } : undefined}>
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-edge bg-bg/90 px-4 backdrop-blur sm:px-6">
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 lg:hidden"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>

          <h2 className="hidden truncate text-sm font-semibold text-ink sm:block">
            {titleForPath(pathname)}
          </h2>
          {collapsed && <div className="hidden lg:block" />}

          <div className="hidden flex-1 sm:flex sm:justify-center">
            <div className="hidden md:block">{searchButton}</div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 md:hidden"
              aria-label="Search (⌘K)"
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>

            <button
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink"
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4" aria-hidden />
              ) : (
                <Moon className="h-4 w-4" aria-hidden />
              )}
            </button>

            {/* Notifications */}
            <div className="relative" ref={bellRef}>
              <button
                onClick={() => {
                  setBellOpen((o) => !o);
                  if (!bellOpen) setActivity((a) => ({ ...a, unread: 0 }));
                }}
                aria-label="Notifications"
                aria-expanded={bellOpen}
                className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink"
              >
                <Bell className="h-4 w-4" aria-hidden />
                {activity.unread > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
                  </span>
                )}
              </button>
              {bellOpen && (
                <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-edge bg-elevated shadow-xl">
                  <div className="flex items-center justify-between border-b border-edge px-4 py-3">
                    <p className="text-sm font-semibold text-ink">Notifications</p>
                    <span className="text-[11px] text-ink-3">live activity</span>
                  </div>
                  <ul className="max-h-[22rem] overflow-y-auto">
                    {activity.items.length === 0 && (
                      <li className="px-4 py-10 text-center text-xs text-ink-3">
                        No activity yet — events appear as soon as the pipeline runs.
                      </li>
                    )}
                    {activity.items.map((a) => {
                      const m = describeActivity(a);
                      const Icon = m.icon;
                      return (
                        <li key={a.id}>
                          <a
                            href={m.href}
                            onClick={m.href ? undefined : (e) => e.preventDefault()}
                            className={`flex items-start gap-3 px-4 py-3 text-left transition hover:bg-surface-2 ${
                              m.href ? 'cursor-pointer' : 'cursor-default'
                            }`}
                          >
                            <span className={`mt-0.5 shrink-0 ${m.iconTone}`}>
                              <Icon className="h-4 w-4" aria-hidden />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink">
                                {m.label}
                              </span>
                              <span className="block truncate text-xs text-ink-3">
                                {m.detail}
                              </span>
                            </span>
                            <span className="shrink-0 text-[11px] text-ink-3">{m.day}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="border-t border-edge px-4 py-2.5">
                    <a
                      href="/cases"
                      className="text-xs font-medium text-accent-ink hover:underline"
                    >
                      View failed payments →
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="Account menu"
                aria-expanded={menuOpen}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-surface text-xs font-semibold text-ink-2 transition hover:border-edge-strong hover:text-ink"
              >
                {initials}
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-edge bg-elevated shadow-xl">
                  <div className="border-b border-edge px-4 py-3">
                    <p className="truncate text-sm font-semibold text-ink">
                      {profile.name ?? 'Demo Workspace'}
                    </p>
                    <p className="truncate text-xs text-ink-3">
                      {profile.role?.replace(/_/g, ' ') ?? 'Merchant Owner'}
                    </p>
                    {profile.email && (
                      <p className="mt-0.5 truncate text-xs text-ink-2">{profile.email}</p>
                    )}
                  </div>
                  <ul className="p-1.5">
                    <li>
                      <a
                        href="/settings"
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink"
                      >
                        <User className="h-4 w-4 text-ink-3" aria-hidden />
                        Policies &amp; account
                      </a>
                    </li>
                    <li>
                      <button
                        onClick={() => {
                          setMenuOpen(false);
                          setConfirmLogout(true);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-danger-ink"
                      >
                        <LogOut className="h-4 w-4 text-ink-3" aria-hidden />
                        Log out
                      </button>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>

        <footer className="border-t border-edge px-6 py-4 text-center text-[11px] text-ink-3">
          RevenuePulse · OBSERVE → UNDERSTAND → ACT — intelligence from your live recovery pipeline
        </footer>
      </div>
    </div>
  );
}