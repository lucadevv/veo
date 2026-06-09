import { Badge, type BadgeProps } from './badge';

// Cada valor de dominio que el admin pinta DEBE estar mapeado, o cae a 'neutral' + texto crudo en
// inglés (ej. un payout PROCESSED se veía gris diciendo "PROCESSED"). Cubre: payout
// (PROCESSED/HELD), docs de flota (PENDING_REVIEW/EXPIRING_SOON) y pagos (CAPTURED/DEBT/REFUNDED).
const SUCCESS = ['APPROVED', 'ACTIVE', 'COMPLETED', 'VERIFIED', 'PASSED', 'PAID', 'PROCESSED', 'CAPTURED', 'VALID', 'RESOLVED'];
const WARN = ['PENDING', 'PENDING_REVIEW', 'IN_REVIEW', 'SCHEDULED', 'PROCESSING', 'EXPIRING', 'EXPIRING_SOON', 'ACKNOWLEDGED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const DANGER = ['REJECTED', 'BLOCKED', 'EXPIRED', 'FAILED', 'SUSPENDED', 'HELD', 'DEBT', 'OPEN', 'TRIGGERED'];

const LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  PENDING_REVIEW: 'Por revisar',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  ACTIVE: 'Activo',
  BLOCKED: 'Bloqueado',
  SUSPENDED: 'Suspendido',
  EXPIRED: 'Vencido',
  EXPIRING: 'Por vencer',
  EXPIRING_SOON: 'Por vencer',
  VERIFIED: 'Verificado',
  IN_REVIEW: 'En revisión',
  SCHEDULED: 'Programada',
  PROCESSING: 'Procesando',
  PROCESSED: 'Pagado',
  PAID: 'Pagado',
  CAPTURED: 'Cobrado',
  HELD: 'Retenido',
  DEBT: 'En deuda',
  REFUNDED: 'Reembolsado',
  PARTIALLY_REFUNDED: 'Reemb. parcial',
  COMPLETED: 'Completado',
  FAILED: 'Fallido',
  OPEN: 'Abierto',
  RESOLVED: 'Resuelto',
  ACKNOWLEDGED: 'Reconocido',
  TRIGGERED: 'Disparado',
  PASSED: 'Aprobada',
  VALID: 'Vigente',
};

function toneFor(status: string): BadgeProps['tone'] {
  const s = status.toUpperCase();
  if (SUCCESS.includes(s)) return 'success';
  if (WARN.includes(s)) return 'warn';
  if (DANGER.includes(s)) return 'danger';
  return 'neutral';
}

/** Pill genérico para estados de dominio (conductores, docs, payouts, etc.) con texto + color. */
export function StatusPill({ status }: { status: string }) {
  return <Badge tone={toneFor(status)}>{LABELS[status.toUpperCase()] ?? status}</Badge>;
}
