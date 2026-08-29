'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type Theme = 'light' | 'dark';

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}>({
  theme: 'light',
  setTheme: () => {},
  toggle: () => {},
});

const THEME_KEY = 'rp-theme';

export function getStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(THEME_KEY);
  return raw === 'dark' || raw === 'light' ? raw : null;
}

export function applyTheme(theme: Theme, animate = false) {
  const root = document.documentElement;
  if (animate) root.classList.add('theme-transitioning');
  root.classList.toggle('dark', theme === 'dark');
  if (animate) {
    window.setTimeout(() => root.classList.remove('theme-transitioning'), 280);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    const stored = getStoredTheme();
    const system: Theme =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    setThemeState(stored ?? system);
    applyTheme(stored ?? system);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      window.localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
    applyTheme(t, true);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}