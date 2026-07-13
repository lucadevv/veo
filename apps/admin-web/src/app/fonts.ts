/**
 * Fuentes self-hosted del sistema "Trust" (diseño light del admin). Todas se auto-hospedan en build
 * (next/font) — cero petición a un tercero en runtime, cumpliendo soberanía. Exponen las CSS vars que
 * consume el theme:
 *   --font-sans    → Outfit         (body, labels, botones)
 *   --font-display → Clash Display  (títulos, logo, dígitos) — la MISMA display de marca de las apps RN
 *   --font-serif   → Fraunces       (headline editorial de marca)
 *   --font-mono    → Space Mono     (timers, IDs, datos monoespaciados)
 *
 * Clash Display es de Fontshare (no está en Google Fonts) → va por next/font/local con los .otf de marca
 * VEO (los mismos que empaquetan apps/passenger y apps/driver). 4 pesos: Regular 400 · Medium 500 ·
 * Semibold 600 · Bold 700 — el rango completo para la jerarquía tipográfica del display.
 */
import { Fraunces, Outfit, Space_Mono } from 'next/font/google';
import localFont from 'next/font/local';

export const fontSans = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

// Display de marca VEO — Clash Display self-hosted (idéntica a las apps móviles). Los 4 pesos como
// familia única: `font-normal/medium/semibold/bold` sobre `font-display` resuelven al archivo correcto.
export const fontDisplay = localFont({
  src: [
    { path: './fonts/ClashDisplay-Regular.otf', weight: '400', style: 'normal' },
    { path: './fonts/ClashDisplay-Medium.otf', weight: '500', style: 'normal' },
    { path: './fonts/ClashDisplay-Semibold.otf', weight: '600', style: 'normal' },
    { path: './fonts/ClashDisplay-Bold.otf', weight: '700', style: 'normal' },
  ],
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
