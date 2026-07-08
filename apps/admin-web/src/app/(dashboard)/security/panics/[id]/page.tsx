'use client';
import { use } from 'react';

import { BellRing, CheckCircle2, FileText, Paperclip } from 'lucide-react';
import { usePanic, usePanicAction } from '@/lib/api/queries';
import { dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/ui/states';
import { StatusPill } from '@/components/ui/status-pill';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { PanicEvidenceDialog } from '@/components/security/panic-evidence-dialog';
import { MapView, type MapMarker } from '@/components/map/lazy-map';

export default function PanicDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const { toast } = useToast();
  const query = usePanic(id);
  const action = usePanicAction();
  const panic = query.data;

  const markers: MapMarker[] = panic
    ? [
        {
          id: 'panic',
          lon: panic.geo.lon,
          lat: panic.geo.lat,
          kind: 'panic',
          label: 'Ubicación del pánico',
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`Pánico ${id.slice(0, 8)}`}
        breadcrumbs={[
          { label: 'Seguridad' },
          { label: 'Pánicos', href: '/security/panics' },
          { label: id.slice(0, 8) },
        ]}
        actions={
          panic ? (
            <div className="flex items-center gap-2">
              <StatusPill status={panic.status} />
              {can(user, 'panics:ack') && !panic.acknowledgedAt ? (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="primary">
                      <BellRing className="size-4" aria-hidden />
                      Reconocer
                    </Button>
                  }
                  title="Reconocer alerta"
                  description="Confirmas que estás atendiendo esta alerta de pánico."
                  confirmLabel="Reconocer"
                  onConfirm={async () => {
                    await action.mutateAsync({ id, action: 'ack' });
                    toast({ tone: 'success', title: 'Alerta reconocida' });
                  }}
                />
              ) : null}
              {can(user, 'panics:resolve') && !panic.resolvedAt ? (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="secondary">
                      <CheckCircle2 className="size-4" aria-hidden />
                      Resolver
                    </Button>
                  }
                  title="Resolver alerta"
                  description="Registra el desenlace del incidente. Esta acción queda auditada."
                  confirmLabel="Resolver"
                  withReason
                  reasonLabel="Notas de resolución"
                  onConfirm={async (reason) => {
                    await action.mutateAsync({ id, action: 'resolve', notes: reason });
                    toast({ tone: 'success', title: 'Alerta resuelta' });
                  }}
                />
              ) : null}
            </div>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : panic ? (
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Incidente</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Viaje" value={panic.tripId.slice(0, 8)} mono />
                <Detail
                  label="Pasajero"
                  value={panic.passengerName ?? panic.passengerId.slice(0, 8)}
                />
                <Detail
                  label="Conductor"
                  value={panic.driverName ?? panic.driverId?.slice(0, 8) ?? '—'}
                />
                <Detail label="Disparado" value={dateTime(panic.triggeredAt)} />
                <Detail label="Reconocido" value={dateTime(panic.acknowledgedAt)} />
                <Detail label="Resuelto" value={dateTime(panic.resolvedAt)} />
                <Detail label="Atendido por" value={panic.acknowledgedBy ?? '—'} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Evidencia</CardTitle>
                {can(user, 'panics:ack') ? (
                  <PanicEvidenceDialog
                    id={id}
                    trigger={
                      <Button size="sm" variant="secondary">
                        <Paperclip className="size-4" aria-hidden />
                        Adjuntar evidencia
                      </Button>
                    }
                  />
                ) : null}
              </CardHeader>
              <CardContent>
                {panic.evidence.length === 0 ? (
                  <EmptyState
                    title="Sin evidencia"
                    description="No hay evidencia asociada todavía."
                  />
                ) : (
                  <ul className="space-y-2">
                    {panic.evidence.map((ev) => (
                      <li
                        key={ev.id}
                        className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                      >
                        <FileText className="size-4 text-ink-muted" aria-hidden />
                        <span className="flex-1 text-sm text-ink">{ev.label}</span>
                        <span className="text-xs text-ink-muted">{dateTime(ev.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="min-h-[320px] overflow-hidden">
            <div className="h-full min-h-[320px]">
              <MapView
                markers={markers}
                center={{ lon: panic.geo.lon, lat: panic.geo.lat }}
                zoom={14}
              />
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-ink tabular' : 'text-ink'}>{value}</dd>
    </div>
  );
}
