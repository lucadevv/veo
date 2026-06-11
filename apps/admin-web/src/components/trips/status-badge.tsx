import type { AdminTripStatus } from '@/lib/api/schemas';
import { Badge, type BadgeProps } from '@/components/ui/badge';

const LABEL: Record<AdminTripStatus, string> = {
  SCHEDULED: 'Programado',
  REQUESTED: 'Solicitado',
  MATCHING: 'Buscando',
  ASSIGNED: 'Asignado',
  ACCEPTED: 'Aceptado',
  ARRIVING: 'En camino',
  ARRIVED: 'En punto',
  IN_PROGRESS: 'En curso',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
  REASSIGNING: 'Reasignando',
  EXPIRED: 'Expirado',
  FAILED: 'Fallido',
  UNKNOWN: 'Desconocido', // status fuera del contrato (drift de versión): visible, nunca disfrazado
};

const TONE: Record<AdminTripStatus, BadgeProps['tone']> = {
  SCHEDULED: 'accent',
  REQUESTED: 'neutral',
  MATCHING: 'accent',
  ASSIGNED: 'accent',
  ACCEPTED: 'accent',
  ARRIVING: 'brand',
  ARRIVED: 'brand',
  IN_PROGRESS: 'success',
  COMPLETED: 'neutral',
  CANCELLED: 'warn',
  REASSIGNING: 'accent', // sigue buscando (como MATCHING)
  EXPIRED: 'warn', // puja sin ofertas, estancado a la espera de re-puja
  FAILED: 'danger', // viaje abandonado cerrado por el watchdog
  UNKNOWN: 'danger', // contrato roto/drift: ops debe escalar, no ignorar
};

/** Estado de viaje siempre con texto + color (nunca solo color). */
export function TripStatusBadge({ status }: { status: AdminTripStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}

/**
 * ¿El viaje está vivo (no terminado/estancado)? Terminales/estancados: COMPLETED, CANCELLED, FAILED
 * (watchdog) y EXPIRED (puja sin ofertas, a la espera de re-puja). REASSIGNING SÍ está vivo (busca
 * otro). UNKNOWN cuenta como vivo a propósito: si no sabemos el estado, ops debe VERLO, no perderlo.
 */
export function isActiveTrip(status: AdminTripStatus): boolean {
  return (
    status !== 'COMPLETED' &&
    status !== 'CANCELLED' &&
    status !== 'FAILED' &&
    status !== 'EXPIRED'
  );
}
