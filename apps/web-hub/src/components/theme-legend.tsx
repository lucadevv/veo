import type { EcosystemApp } from '@/domain/ecosystem';
import { accentTokens } from '@/theme/accents';

interface ThemeLegendProps {
  readonly apps: readonly EcosystemApp[];
}

/** Leyenda de color: un punto por app, derivada de los mismos datos y acentos. */
export function ThemeLegend({ apps }: ThemeLegendProps) {
  return (
    <div className="mt-[34px] flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[12px] text-ink-subtle">
      {apps.map((app) => (
        <span key={app.key} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: accentTokens(app.accent).color }}
            aria-hidden="true"
          />
          {app.name}
        </span>
      ))}
    </div>
  );
}
