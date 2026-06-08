import { Badge, type BadgeProps } from './badge';

const SUCCESS = ['APPROVED', 'ACTIVE', 'COMPLETED', 'VERIFIED', 'PASSED', 'PAID', 'VALID', 'RESOLVED'];
const WARN = ['PENDING', 'IN_REVIEW', 'SCHEDULED', 'PROCESSING', 'EXPIRING', 'ACKNOWLEDGED'];
const DANGER = ['REJECTED', 'BLOCKED', 'EXPIRED', 'FAILED', 'SUSPENDED', 'OPEN', 'TRIGGERED'];

const LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  ACTIVE: 'Activo',
  BLOCKED: 'Bloqueado',
  SUSPENDED: 'Suspendido',
  EXPIRED: 'Vencido',
  EXPIRING: 'Por vencer',
  VERIFIED: 'Verificado',
  IN_REVIEW: 'En revisión',
  SCHEDULED: 'Programada',
  PROCESSING: 'Procesando',
  PAID: 'Pagado',
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
