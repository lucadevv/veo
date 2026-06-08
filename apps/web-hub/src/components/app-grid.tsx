import type { EcosystemApp } from '@/domain/ecosystem';
import { AppCard } from './app-card';

interface AppGridProps {
  readonly apps: readonly EcosystemApp[];
}

/** Grilla 2×2 (1 col en móvil) que compone una `AppCard` por experiencia. */
export function AppGrid({ apps }: AppGridProps) {
  return (
    <div className="mt-[46px] grid grid-cols-2 gap-[18px] max-[760px]:grid-cols-1">
      {apps.map((app) => (
        <AppCard key={app.key} app={app} />
      ))}
    </div>
  );
}
