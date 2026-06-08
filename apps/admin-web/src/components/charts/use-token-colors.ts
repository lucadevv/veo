'use client';

import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme';

export interface TokenColors {
  accent: string;
  brand: string;
  success: string;
  warn: string;
  danger: string;
  inkMuted: string;
  border: string;
}

const FALLBACK: TokenColors = {
  accent: 'oklch(0.6 0.12 230)',
  brand: 'oklch(0.32 0.08 264)',
  success: 'oklch(0.62 0.14 162)',
  warn: 'oklch(0.72 0.15 75)',
  danger: 'oklch(0.58 0.2 22)',
  inkMuted: 'oklch(0.47 0.02 264)',
  border: 'oklch(0.9 0.008 264)',
};

function read(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Lee los colores de los tokens OKLCH para pasarlos a recharts (que los aplica como
 * atributos SVG). Recalcula al cambiar el tema. No se hardcodea ningún color.
 */
export function useTokenColors(): TokenColors {
  const { theme } = useTheme();
  const [colors, setColors] = useState<TokenColors>(FALLBACK);

  useEffect(() => {
    setColors({
      accent: read('--accent', FALLBACK.accent),
      brand: read('--brand', FALLBACK.brand),
      success: read('--success', FALLBACK.success),
      warn: read('--warn', FALLBACK.warn),
      danger: read('--danger', FALLBACK.danger),
      inkMuted: read('--ink-muted', FALLBACK.inkMuted),
      border: read('--border', FALLBACK.border),
    });
  }, [theme]);

  return colors;
}
