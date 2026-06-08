import { ECOSYSTEM_APPS } from '@/data/ecosystem';
import { SiteHeader } from '@/components/site-header';
import { Hero } from '@/components/hero';
import { AppGrid } from '@/components/app-grid';
import { ThemeLegend } from '@/components/theme-legend';
import { SiteFooter } from '@/components/site-footer';

/**
 * Landing del ecosistema VEO. Solo COMPONE secciones — cada una es responsable
 * de su propio render. Los datos entran por `data/ecosystem.ts` (SSOT).
 */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-wrap px-6 pb-16 pt-14">
      <SiteHeader />
      <Hero />
      <AppGrid apps={ECOSYSTEM_APPS} />
      <ThemeLegend apps={ECOSYSTEM_APPS} />
      <SiteFooter />
    </main>
  );
}
