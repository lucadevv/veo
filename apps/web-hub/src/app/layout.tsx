import type { Metadata, Viewport } from 'next';
import { Outfit, Space_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';

// Fuentes del sistema "Trust", auto-hospedadas en build (next/font, sin CDN en runtime —
// compatible con la CSP self). Mismo trío que admin-web (patrón fonts.ts):
//   --font-display → Clash Display (títulos, logo) — la MISMA display de marca de las apps RN
//   --font-sans    → Outfit        (cuerpo, labels, botones)
//   --font-mono    → Space Mono    (datos monoespaciados, chips técnicos)
const fontDisplay = localFont({
  src: [
    { path: './fonts/ClashDisplay-Regular.otf', weight: '400', style: 'normal' },
    { path: './fonts/ClashDisplay-Medium.otf', weight: '500', style: 'normal' },
    { path: './fonts/ClashDisplay-Semibold.otf', weight: '600', style: 'normal' },
    { path: './fonts/ClashDisplay-Bold.otf', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-display',
});

const fontSans = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const fontMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'VEO · Ecosistema',
  description:
    'Una sola plataforma, cuatro experiencias conectadas: Pasajero, Conductor, Familia y Admin. Movilidad segura en Lima, Perú.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Canvas Trust light (--bg del sistema compartido).
  themeColor: '#F5F7FA',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es-PE"
      className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}
    >
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
