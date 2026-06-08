import type { Metadata, Viewport } from 'next';
import { fontMono, fontSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'VEO Admin · Operación y Seguridad',
  description: 'Centro de control de operación, seguridad, flota y finanzas de VEO.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f9fc' },
    { media: '(prefers-color-scheme: dark)', color: '#13182a' },
  ],
};

// Aplica el tema persistido antes del primer paint para evitar parpadeo (FOUC).
const themeInitScript = `(function(){try{var t=localStorage.getItem('veo-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${fontSans.variable} ${fontMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
