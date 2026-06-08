import { Clock } from 'lucide-react';
import type { FamilyTrackingView } from '@veo/api-client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { describeEta, describeStatus } from '@/lib/format';

const SHOW_ETA_STATUSES = new Set<FamilyTrackingView['status']>([
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'IN_PROGRESS',
]);

/** Tarjeta principal: estado del viaje + tiempo de llegada en lenguaje natural. */
export function StatusCard({ view }: { view: FamilyTrackingView }) {
  const status = describeStatus(view.status);
  const showEta = SHOW_ETA_STATUSES.has(view.status);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-muted">Estado del viaje</h2>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {view.passengerName ? (
        <p className="mt-3 text-lg font-semibold leading-snug">Viaje de {view.passengerName}</p>
      ) : null}
      {showEta ? (
        <p className="mt-3 flex items-center gap-2 text-base text-ink">
          <Clock className="size-5 shrink-0 text-accent" aria-hidden />
          <span className="tabular">{describeEta(view.etaSeconds)}</span>
        </p>
      ) : null}
    </Card>
  );
}
