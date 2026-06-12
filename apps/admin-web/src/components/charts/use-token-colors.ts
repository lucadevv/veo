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

// Fallback alineado a los tokens de marca VEO (lienzo negro + VEO Cyan). Espeja `tokens.css`;
// es solo un respaldo para SSR / antes de que el navegador resuelva las CSS vars.
const FALLBACK: TokenColors = {
  accent: 'oklch(0.823 0.135 207)',
  brand: 'oklch(0.823 0.135 207)',
  success: 'oklch(0.78 0.14 162)',
  warn: 'oklch(0.80 0.13 75)',
  danger: 'oklch(0.65 0.21 17)',
  inkMuted: 'oklch(0.86 0.008 263)',
  border: 'oklch(0.20 0.003 286)',
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
