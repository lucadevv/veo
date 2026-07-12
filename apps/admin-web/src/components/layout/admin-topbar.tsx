import type { ReactNode } from 'react';

/**
 * Topbar por-pantalla fiel al T/AdminTopbar de veo.pen: barra blanca sticky con borde inferior, título
 * (Space Grotesk) + subtítulo (Outfit) a la izquierda y acciones a la derecha (badge en vivo, rango, botones).
 * Reusable en todas las pantallas del panel.
 */
export function AdminTopbar({
  title,
  subtitle,
  breadcrumb,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** Migaja opcional sobre el título (fiel al DetailHeader del board: "Sección / #actual"). */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-sticky flex items-center justify-between gap-4 border-b border-[color:var(--divider)] bg-surface px-7 py-[18px]">
      <div className="flex flex-col gap-0.5">
        {breadcrumb ? <div className="text-[13px] text-ink-muted">{breadcrumb}</div> : null}
        <h1 className="font-display text-[23px] font-bold tracking-[-0.4px] text-ink">{title}</h1>
        {subtitle ? <p className="text-[13px] text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
    </header>
  );
}
