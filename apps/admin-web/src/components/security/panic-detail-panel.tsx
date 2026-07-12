'use client';

import Link from 'next/link';
import { BellRing, CheckCircle2, FileText, Paperclip, Video } from 'lucide-react';
import { usePanic, usePanicAction, useTrip } from '@/lib/api/queries';
import { dateTime, relativeFromNow } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/ui/states';
import { StatusPill } from '@/components/ui/status-pill';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { PanicEvidenceDialog } from '@/components/security/panic-evidence-dialog';
import { PanicResolveDialog } from '@/components/security/panic-resolve-dialog';
import { MapView, type MapMarker } from '@/components/map/lazy-map';

/** Iniciales (2) de un nombre para el avatar; sin nombre → "•". */
function initials(name: string | null | undefined): string {
  if (!name) return '•';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '•';
}

/**
 * Detalle de un incidente de pánico (Centro de pánico · fiel al frame BQPRE): mapa de ubicación, tarjetas de
 * pasajero/conductor, y las acciones de respuesta. Reusable por el master-detail (panel derecho) y la página
 * `/security/panics/[id]` (deep-link). La LÓGICA de seguridad (ack/resolve/evidencia + RBAC) se preserva
 * intacta — solo cambia la presentación. Datos NO en el modelo (severidad/teléfono/placa/rating) se OMITEN
 * (honesto, no se inventan).
 */
export function PanicDetailPanel({ id }: { id: string }) {
  const user = useSession();
  const { toast } = useToast();
  const query = usePanic(id);
  const action = usePanicAction();
  const panic = query.data;
  // Viaje del incidente (para dibujar la RUTA en el mapa): origen → punto de pánico. `enabled` interno de
  // useTrip evita el fetch si aún no hay tripId. La geo exacta puede venir null (redacción por rol) → sin ruta.
  const trip = useTrip(panic?.tripId ?? '').data;

  if (query.isLoading) {
    return (
      <div className="grid gap-4 p-5">
        <Skeleton className="h-64" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} className="m-5" />;
  if (!panic) return null;

  // Ruta = origen del viaje → punto de pánico (línea roja). Origen solo si el viaje trae geo exacta (puede
  // venir null por redacción de rol o sin match). Sin origen → solo el marcador del pánico (degradación honesta).
  const origin = trip?.origin ?? null;
  const route = origin ? [origin, panic.geo] : undefined;
  const markers: MapMarker[] = [
    ...(origin
      ? [{ id: 'origin', lon: origin.lon, lat: origin.lat, kind: 'trip' as const, label: 'Origen del viaje' }]
      : []),
    { id: 'panic', lon: panic.geo.lon, lat: panic.geo.lat, kind: 'panic' as const, label: 'Ubicación del pánico' },
  ];
  const mapCenter = origin
    ? { lon: (origin.lon + panic.geo.lon) / 2, lat: (origin.lat + panic.geo.lat) / 2 }
    : { lon: panic.geo.lon, lat: panic.geo.lat };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-5">
      {/* Encabezado del incidente */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="font-mono text-lg font-semibold text-ink">Pánico #{id.slice(0, 8)}</h2>
          <StatusPill status={panic.status} />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-ink-muted">Activado {relativeFromNow(panic.triggeredAt)}</span>
          <Link
            href={`/security/panics/${id}`}
            className="text-[13px] font-semibold text-accent transition-opacity hover:opacity-80"
          >
            Ver detalle completo →
          </Link>
        </div>
      </div>

      {/* Mapa de ubicación. shrink-0: en un flex-col con overflow-y-auto, el flex encogería este Card (y su
          overflow-hidden recortaría el mapa a una franja). Con shrink-0 conserva su altura y el panel scrollea. */}
      <Card className="h-[340px] shrink-0 overflow-hidden">
        <MapView markers={markers} route={route} center={mapCenter} zoom={origin ? 12 : 14} />
      </Card>

      {/* Pasajero + Conductor */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Party
          eyebrow="PASAJERO"
          name={panic.passengerName}
          fallbackId={panic.passengerId}
          sub={null}
        />
        <Party
          eyebrow="CONDUCTOR"
          name={panic.driverName}
          fallbackId={panic.driverId ?? '—'}
          sub={null}
        />
      </div>

      {/* Acciones de respuesta (fiel al frame: cámara en vivo + resolver; ack = "atender") */}
      <div className="flex flex-wrap gap-3">
        {can(user, 'panics:ack') && !panic.acknowledgedAt ? (
          <ConfirmDialog
            trigger={
              <Button variant="primary">
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
        {can(user, 'live:view') ? (
          <Link
            href={`/security/live-wall?trip=${panic.tripId}`}
            className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-control border border-border bg-surface-2 px-4 text-sm font-semibold text-ink transition-colors hover:border-border-strong active:scale-[0.97]"
          >
            <Video className="size-4" aria-hidden />
            Ver cámara en vivo
          </Link>
        ) : null}
        {can(user, 'panics:resolve') && !panic.resolvedAt ? (
          <PanicResolveDialog
            id={id}
            trigger={
              <Button variant="secondary">
                <CheckCircle2 className="size-4" aria-hidden />
                Marcar resuelto
              </Button>
            }
          />
        ) : null}
      </div>

      {/* Ficha del incidente */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm">
          <Detail label="Viaje" value={panic.tripId.slice(0, 8)} mono />
          <Detail label="Disparado" value={dateTime(panic.triggeredAt)} />
          <Detail label="Reconocido" value={dateTime(panic.acknowledgedAt)} />
          <Detail label="Resuelto" value={dateTime(panic.resolvedAt)} />
          <Detail label="Atendido por" value={panic.acknowledgedBy ?? '—'} />
          {panic.notes ? (
            <div className="col-span-2">
              <dt className="text-xs text-ink-muted">Motivo del cierre</dt>
              <dd className="whitespace-pre-wrap text-ink">{panic.notes}</dd>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Evidencia */}
      <Card>
        <div className="flex items-center justify-between border-b border-[color:var(--divider)] px-4 py-3">
          <p className="text-sm font-semibold text-ink">Evidencia</p>
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
        </div>
        <CardContent className="p-4">
          {panic.evidence.length === 0 ? (
            <EmptyState title="Sin evidencia" description="No hay evidencia asociada todavía." />
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
  );
}

/** Tarjeta de persona (pasajero/conductor): avatar de iniciales + eyebrow + nombre (o id honesto). */
function Party({
  eyebrow,
  name,
  fallbackId,
  sub,
}: {
  eyebrow: string;
  name: string | null;
  fallbackId: string;
  sub: string | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-black/[0.05] bg-bg p-3.5">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent/10 text-[13px] font-semibold text-accent">
        {initials(name)}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-[11px] font-bold tracking-[0.05em] text-ink-subtle">{eyebrow}</span>
        <span className="truncate text-sm font-medium text-ink">
          {name ?? <span className="font-mono text-xs text-ink-muted">{fallbackId.slice(0, 8)}</span>}
        </span>
        {sub ? <span className="truncate text-xs text-ink-subtle">{sub}</span> : null}
      </div>
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
