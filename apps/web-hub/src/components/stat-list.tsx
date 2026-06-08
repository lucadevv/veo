import type { EcosystemStat } from '@/domain/ecosystem';
import { cn } from '@/lib/cn';

interface StatListProps {
  readonly stats: readonly EcosystemStat[];
}

/** Fila de métricas del hero. */
export function StatList({ stats }: StatListProps) {
  return (
    <dl className="mt-[26px] flex flex-wrap gap-7">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dd className={cn('font-display text-[26px] font-bold leading-none', stat.mono && 'font-mono')}>
            {stat.value}
          </dd>
          <dt className="mt-0.5 text-[12.5px] text-ink-subtle">{stat.label}</dt>
        </div>
      ))}
    </dl>
  );
}
