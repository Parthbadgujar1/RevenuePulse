'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/cases', label: 'Cases' },
  { href: '/actions', label: 'Recovery Actions' },
  { href: '/checkout', label: 'Checkout' },
  { href: '/receivables', label: 'Receivables' },
  { href: '/promises', label: 'Promises' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/demo-lab', label: 'Demo Lab' },
  { href: '/ingest', label: 'Import Data' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/settings', label: 'Policies' },
];

export default function AppNav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-slate-800 bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="text-lg font-bold tracking-tight text-emerald-400">
          RevenuePulse
        </Link>
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          {LINKS.map((l) => {
            const active =
              pathname === l.href ||
              (l.href !== '/dashboard' && pathname.startsWith(l.href));
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 transition ${
                  active
                    ? 'bg-emerald-500/15 font-semibold text-emerald-400'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
