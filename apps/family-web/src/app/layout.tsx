import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import { fontDisplay, fontMono, fontSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'VEO Family · Sigue el viaje en vivo',
  description:
    'Mira en tiempo real el viaje de tu familiar desde el link que te compartieron. Sin instalar nada.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Identidad Trust: lienzo CLARO — la barra del navegador acompaña el fondo `--bg` (#F5F7FA).
  themeColor: '#F5F7FA',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es"
      className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}
    >
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
