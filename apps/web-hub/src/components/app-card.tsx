import type { EcosystemApp } from '@/domain/ecosystem';
import { accentTokens } from '@/theme/accents';
import { cn } from '@/lib/cn';
import { AppIcon } from './app-icon';
import { FeatureChips } from './feature-chips';

interface AppCardProps {
  readonly app: EcosystemApp;
}

/**
 * Tarjeta de una experiencia del ecosistema. Recibe el dato y resuelve sus colores
 * desde el acento (SRP: solo pinta una app; no conoce a las demás ni a la grilla).
 */
export function AppCard({ app }: AppCardProps) {
  const accent = accentTokens(app.accent);

  return (
    <article className="group relative overflow-hidden rounded-card border border-border bg-surface p-[26px] transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-border-strong">
      {/* Barra de acento superior */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: accent.color }} aria-hidden="true" />

      {/* Chip del ícono: relleno con el acento si es `solid`, fantasma si no */}
      <div
        className="mb-[18px] flex h-[46px] w-[46px] items-center justify-center rounded-[13px] border"
        style={{
          background: app.solid ? accent.color : 'var(--surface-2)',
          borderColor: app.solid ? accent.color : 'var(--border)',
          color: accent.iconStroke,
        }}
      >
        <AppIcon name={app.icon} />
      </div>

      <h2 className="flex items-center gap-2.5 font-display text-[22px] font-semibold">
        App {app.name}
        <span className="rounded-md border border-border bg-surface-2 px-2 py-[3px] font-mono text-[11px] font-semibold text-ink-muted">
          {app.theme}
        </span>
      </h2>

      <p className="mt-[9px] min-h-[42px] text-[14px] leading-[1.5] text-ink-muted">{app.description}</p>

      <FeatureChips features={app.features} />

      <div className="mt-5 flex gap-2.5">
        <a
          href={app.links.primary.href}
          className={cn(
            'flex h-12 flex-1 items-center justify-center gap-2 rounded-[13px] text-[14px] font-semibold transition-[filter,transform] active:scale-[.98]',
            app.solid ? 'hover:brightness-105' : 'border border-border bg-surface-2 hover:border-border-strong',
          )}
          style={app.solid ? { background: accent.color, color: accent.onColor } : { color: accent.color }}
        >
          {app.links.primary.label}
        </a>
        <a
          href={app.links.secondary.href}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[13px] border border-border bg-surface-2 text-[14px] font-semibold text-ink transition-colors hover:border-border-strong"
        >
          {app.links.secondary.label}
        </a>
      </div>
    </article>
  );
}
