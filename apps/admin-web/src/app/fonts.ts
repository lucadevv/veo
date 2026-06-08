/**
 * Fuentes self-hosted. next/font/google descarga y auto-hospeda los archivos en build
 * (no hay petición a Google en runtime), cumpliendo la regla de soberanía.
 * Exponen las CSS vars que consume tokens.css (--font-sans / --font-mono).
 */
import { Inter, JetBrains_Mono } from 'next/font/google';

export const fontSans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});
