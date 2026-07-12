import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { RefundStatusValue } from '@/lib/api/schemas';

/**
 * Pill de estado de un reembolso, FIEL al frame HZ8uz (labels + tonos propios de la cola, distintos del
 * `StatusPill` genérico): el frame distingue "Aprobado" (desembolso en vuelo · brand) de "Procesado" (plata
 * confirmada · success), cosa que el mapa genérico —que pinta ambos verdes— NO refleja. Por eso un pill
 * dedicado en vez de reusar StatusPill. Los tonos salen de los tokens del tema (brand/success/warn/danger),
 * nunca hex crudo: el amber del frame ≈ warn, el cyan ≈ brand (#0075A9), el verde ≈ success, el rojo ≈ danger.
 */
const REFUND_STATUS: Record<RefundStatusValue, { label: string; tone: BadgeProps['tone'] }> = {
  PENDING: { label: 'Solicitado', tone: 'warn' },
  APPROVED: { label: 'Aprobado', tone: 'brand' },
  COMPLETED: { label: 'Procesado', tone: 'success' },
  REJECTED: { label: 'Rechazado', tone: 'danger' },
};

export function RefundStatusPill({ status }: { status: RefundStatusValue }) {
  const { label, tone } = REFUND_STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}
