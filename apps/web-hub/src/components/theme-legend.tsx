import type { EcosystemApp } from '@/domain/ecosystem';
import { AppIcon } from './app-icon';

interface ThemeLegendProps {
  readonly apps: readonly EcosystemApp[];
}

/**
 * Índice de las cuatro experiencias. VEO es monomarca (una sola marca azul), así
 * que la diferencia NO es de color: cada entrada se identifica por su ÍCONO y su
 * nombre, todos en el azul de marca. (Antes era una leyenda de colores; con el
 * colapso a monomarca esa leyenda dejó de tener sentido.)
 */
export function ThemeLegend({ apps }: ThemeLegendProps) {
  return (
    <div className="mt-[34px] flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-ink-subtle">
      {apps.map((app) => (
        <span key={app.key} className="flex items-center gap-1.5">
          <span className="text-brand" aria-hidden="true">
            <AppIcon name={app.icon} size={14} />
          </span>
          {app.name}
        </span>
      ))}
    </div>
  );
}
