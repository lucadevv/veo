/**
 * Fuentes self-hosted del sistema "Trust" (diseño light del admin). next/font/google descarga y
 * auto-hospeda los archivos en build (no hay petición a Google en runtime), cumpliendo soberanía.
 * Exponen las CSS vars que consume el theme:
 *   --font-sans    → Outfit         (body, labels, botones)
 *   --font-display → Space Grotesk  (títulos, logo, dígitos)
 *   --font-serif   → Fraunces       (headline editorial de marca)
 *   --font-mono    → Space Mono     (timers, IDs, datos monoespaciados)
 */
import { Fraunces, Outfit, Space_Grotesk, Space_Mono } from 'next/font/google';

export const fontSans = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export const fontDisplay = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
});

export const fontSerif = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-serif',
});

export const fontMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-mono',
});
