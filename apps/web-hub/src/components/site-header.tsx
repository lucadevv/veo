import { BrandMark } from './brand-mark';

/** Encabezado del hub: marca + chip de contexto. */
export function SiteHeader() {
  return (
    <header className="mb-[42px] flex items-center gap-[11px]">
      <BrandMark />
      <span className="ml-1 rounded-md border border-border bg-surface-2 px-2 py-[3px] font-mono text-[11px] font-semibold text-ink-muted">
        Ecosistema · Lima, Perú
      </span>
    </header>
  );
}
