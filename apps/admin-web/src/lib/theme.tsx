'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'veo-theme';

function currentDomTheme(): Theme {
  // La marca VEO es un lienzo negro: el default es dark cuando no hay DOM (SSR).
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // El script inline de layout ya fijó la clase antes del paint; sincronizamos el estado.
  // Default dark: la marca VEO arranca en el lienzo negro.
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(currentDomTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage puede no estar disponible (modo privado); el tema sigue activo en sesión.
      }
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de ThemeProvider');
  return ctx;
}
