import type { TripSummary } from '@/lib/api/schemas';
import { Badge, type BadgeProps } from '@/components/ui/badge';

/** Modo de despacho del viaje (contrato: FIXED|PUJA · enriquecido on-read desde trip-service). */
type DispatchMode = NonNullable<TripSummary['dispatchMode']>;

const MODE_LABEL: Record<DispatchMode, string> = {
  FIXED: 'Fijo',
  PUJA: 'Puja',
};

// Tonos del sistema alineados con el donut de Métricas: Fijo=brand (azul), Puja=warn (ámbar).
const MODE_TONE: Record<DispatchMode, BadgeProps['tone']> = {
  FIXED: 'brand',
  PUJA: 'warn',
};

/**
 * Modo de despacho del viaje (Fijo/Puja) con texto + color (nunca solo color). `null` → "—" honesto:
 * trip-service no resolvió el modo (viaje sin dispatchMode congelado). Componente canónico reusado por la
 * lista y el detalle de viaje.
 */
export function TripModePill({ mode }: { mode: DispatchMode | null }) {
  if (!mode) return <span className="text-[13px] text-ink-subtle">—</span>;
  return <Badge tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Badge>;
}

/** Etiqueta del modo (Fijo/Puja) en texto plano; "—" honesto si null. Para filas de texto (ej. Tarifa del detalle). */
export function dispatchModeLabel(mode: DispatchMode | null): string {
  return mode ? MODE_LABEL[mode] : '—';
}
