import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// Fuentes auto-hospedadas por next/font (sin CDN en runtime). Exponen --font-sans/--font-mono.
const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'VEO Family · Sigue el viaje en vivo',
  description: 'Mira en tiempo real el viaje de tu familiar desde el link que te compartieron. Sin instalar nada.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Marca VEO = lienzo NEGRO: la barra del navegador acompaña el negro de marca (#000000).
  themeColor: '#000000',
};

// La marca VEO es un lienzo negro: family-web no tiene toggle, siempre arranca en oscuro.
// Fijamos la clase antes del paint para alinear color-scheme y evitar parpadeo.
const themeScript = `(function(){try{document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${fontSans.variable} ${fontMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
