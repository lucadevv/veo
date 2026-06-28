import type { ReactNode } from 'react';

/**
 * Agrupador de paneles de pricing por CARRIL (on-demand / carpooling / ambos modos). Da el encabezado de
 * sección — un eyebrow con el MISMO estilo que los grupos del sidebar (uppercase + tracking + ink-subtle) —
 * y un divisor superior, para que el operador vea de un vistazo qué config gobierna cada modo. Resuelve la
 * incoherencia del audit: 7 paneles heterogéneos de 2 carriles apilados sin separación bajo un solo título.
 *
 * El `<h2>` de la sección encabeza paneles hijos que llevan su propio `<h3>` → jerarquía página(h1) ›
 * sección(h2) › panel(h3). La UI solo AGRUPA: no decide nada, cada panel mantiene su gate server-side.
 */
export function PricingSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-border pt-5 first:mt-2 first:border-t-0 first:pt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-subtle">
        {title}
      </h2>
      {hint ? <p className="mt-1 max-w-2xl text-xs text-ink-subtle">{hint}</p> : null}
      {children}
    </section>
  );
}
