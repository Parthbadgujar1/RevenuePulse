'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, ChevronsLeft, ChevronsRight, LogOut, X } from 'lucide-react';
import { NAV_GROUPS, isActive } from './nav-model';

export function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      href="/dashboard"
      className={`flex items-center gap-2.5 ${collapsed ? 'justify-center' : ''}`}
      aria-label="RevenuePulse dashboard"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
        <Activity className="h-5 w-5" aria-hidden />
      </span>
      {!collapsed && (
        <span className="text-[15px] font-semibold tracking-tight text-ink">
          Revenue<span className="text-accent-ink">Pulse</span>
        </span>
      )}
    </Link>
  );
}

export function SideNav({
  collapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          {!collapsed && (
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3">
              {group.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      collapsed ? 'justify-center' : ''
                    } ${
                      active
                        ? 'bg-accent/10 text-accent-ink'
                        : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-accent-ink' : 'text-ink-3 group-hover:text-ink-2'}`}
                      aria-hidden
                    />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SidebarFooter({
  collapsed,
  onLogout,
}: {
  collapsed?: boolean;
  onLogout: () => void;
}) {
  return (
    <div className="border-t border-edge p-3">
      <button
        onClick={onLogout}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-danger-ink ${
          collapsed ? 'justify-center' : ''
        }`}
        title={collapsed ? 'Log out' : undefined}
      >
        <LogOut className="h-[18px] w-[18px] shrink-0 text-ink-3" aria-hidden />
        {!collapsed && <span>Log out</span>}
      </button>
    </div>
  );
}

export function CollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
    >
      {collapsed ? (
        <ChevronsRight className="h-4 w-4" aria-hidden />
      ) : (
        <ChevronsLeft className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

export function CloseDrawerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Close navigation menu"
      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}