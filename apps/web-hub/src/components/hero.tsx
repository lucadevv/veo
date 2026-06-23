import { ECOSYSTEM_STATS } from '@/data/ecosystem';
import { StatList } from './stat-list';

/** Sección hero: promesa de marca + métricas. */
export function Hero() {
  return (
    <section className="hero">
      <p className="font-semibold uppercase tracking-eyebrow text-[11px] text-brand">
        Yo veo · Tú vas seguro
      </p>
      <h1 className="mt-3.5 max-w-[680px] font-display text-[44px] font-semibold leading-[1.05] tracking-[-0.02em] max-[760px]:text-[34px]">
        Una sola plataforma,
        <br />
        cuatro experiencias conectadas.
      </h1>
      <p className="mt-4 max-w-[560px] text-[17px] leading-[1.55] text-ink-muted">
        Movilidad con la seguridad como capa transversal: tú pones el precio, tu familia te ve
        llegar, y todo viaje se graba, analiza y audita. Explora cada app como prototipo clicable o
        como lienzo de flujo completo.
      </p>
      <StatList stats={ECOSYSTEM_STATS} />
    </section>
  );
}
