/**
 * Fuentes de la identidad "Trust" (mismas familias que admin-web/web-hub y las apps RN). Todas se
 * auto-hospedan en build (next/font) — cero petición a un tercero en runtime, cumpliendo soberanía.
 * Exponen las CSS vars que consume el theme:
 *   --font-sans    → Outfit         (body, labels, botones)
 *   --font-display → Clash Display  (títulos, logo) — la MISMA display de marca de las apps RN
 *   --font-mono    → Space Mono     (ETA, placas, datos monoespaciados)
 *
 * Clash Display es de Fontshare (no está en Google Fonts) → va por next/font/local con los .otf de
 * marca VEO (los mismos que empaquetan apps/passenger, apps/driver, admin-web y web-hub).
 */
import { Outfit, Space_Mono } from 'next/font/google';
import localFont from 'next/font/local';

export const fontSans = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

// Display de marca VEO — Clash Display self-hosted. Los 4 pesos como familia única:
// `font-normal/medium/semibold/bold` sobre `font-display` resuelven al archivo correcto.
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

export const fontMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-mono',
});
