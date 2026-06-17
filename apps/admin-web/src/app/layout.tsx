import type { Metadata, Viewport } from 'next';
import { fontMono, fontSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'VEO Admin · Operación y Seguridad',
  description: 'Centro de control de operación, seguridad, flota y finanzas de VEO.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Marca VEO = lienzo NEGRO: la barra del navegador acompaña el negro de marca (#000000).
  themeColor: '#000000',
};

// Aplica el tema persistido antes del primer paint para evitar parpadeo (FOUC). La marca VEO
// es oscura: el default (sin preferencia guardada) es dark, no se delega a prefers-color-scheme.
const themeInitScript = `(function(){try{var t=localStorage.getItem('veo-theme');var d=t?t==='dark':true;document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es"
      className={`${fontSans.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
