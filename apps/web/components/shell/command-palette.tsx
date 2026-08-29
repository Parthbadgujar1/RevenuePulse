'use client';

import { useRouter } from 'next/navigation';
import { CornerDownLeft, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FLAT_ITEMS } from './nav-model';

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FLAT_ITEMS;
    return FLAT_ITEMS.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.section ?? '').toLowerCase().includes(q) ||
        i.href.includes(q),
    ).slice(0, 12);
  }, [query]);

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-edge bg-elevated shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search RevenuePulse…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            aria-label="Search"
          />
          <kbd className="shrink-0 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
            ESC
          </kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-ink-3">
              No results for “{query}”
            </li>
          )}
          {results.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <button
                  onClick={() => go(item.href)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-ink transition hover:bg-surface-2"
                >
                  <Icon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  {item.section && (
                    <span className="text-[10px] uppercase tracking-wider text-ink-3">
                      {item.section}
                    </span>
                  )}
                  <CornerDownLeft className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}