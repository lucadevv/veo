import type { Metadata, Viewport } from 'next';
import { fontDisplay, fontMono, fontSans, fontSerif } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'VEO Admin · Operación y Seguridad',
  description: 'Centro de control de operación, seguridad, flota y finanzas de VEO.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Sistema "Trust" = lienzo CLARO: la barra del navegador acompaña el gris de página (#F5F7FA).
  themeColor: '#F5F7FA',
};

// Aplica el tema persistido antes del primer paint para evitar parpadeo (FOUC). El sistema "Trust"
// es CLARO: el default (sin preferencia guardada) es light; solo se activa .dark si el operador lo eligió.
const themeInitScript = `(function(){try{var t=localStorage.getItem('veo-theme');document.documentElement.classList.toggle('dark',t==='dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es"
      className={`${fontSans.variable} ${fontDisplay.variable} ${fontSerif.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
