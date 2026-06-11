'use client';

import { useMemo, use } from 'react';
import { useTrip } from '@/lib/api/queries';
import type { TripDetail } from '@/lib/api/schemas';
import { dateTime, duration, money } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { TripStatusBadge } from '@/components/trips/status-badge';
import { MapView, type MapMarker } from '@/components/map/lazy-map';

export default function TripDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const query = useTrip(id);
  const trip = query.data;

  const markers = useMemo<MapMarker[]>(() => buildMarkers(trip), [trip]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`Viaje ${id.slice(0, 8)}`}
        breadcrumbs={[
          { label: 'Operación' },
          { label: 'Viajes', href: '/ops/trips' },
          { label: id.slice(0, 8) },
        ]}
        actions={trip ? <TripStatusBadge status={trip.status} /> : null}
      />

      {query.isLoading ? (
        <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : trip ? (
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Resumen</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Tarifa" value={money(trip.fareCents)} mono />
                <Detail label="Método de pago" value={trip.paymentMethod ?? '—'} />
                <Detail label="Pasajero" value={trip.passengerName ?? trip.passengerId.slice(0, 8)} />
                <Detail label="Conductor" value={trip.driverName ?? trip.driverId?.slice(0, 8) ?? '—'} />
                {/* Alerta solo si el conductor está suspendido (identity DriverReply.suspendedAt); si es null no se renderiza nada. */}
                {trip.driverSuspendedAt != null && (
                  <div className="col-span-2">
                    <Badge tone="warn">Conductor suspendido el {dateTime(trip.driverSuspendedAt)}</Badge>
                  </div>
                )}
                <Detail label="Placa" value={trip.vehiclePlate ?? '—'} mono />
                <Detail label="ETA" value={duration(trip.etaSeconds)} />
                <Detail
                  label="Distancia"
                  value={trip.distanceMeters ? `${(trip.distanceMeters / 1000).toFixed(1)} km` : '—'}
                />
                <Detail label="Creado" value={dateTime(trip.createdAt)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Línea de tiempo</CardTitle>
              </CardHeader>
              <CardContent>
                {trip.timeline.length === 0 ? (
                  <p className="text-sm text-ink-muted">Sin eventos registrados.</p>
                ) : (
                  <ol className="space-y-3">
                    {trip.timeline.map((ev, i) => (
                      <li key={`${ev.status}-${i}`} className="flex items-center gap-3">
                        <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden />
                        <TripStatusBadge status={ev.status} />
                        <span className="ml-auto text-xs text-ink-muted tabular">
                          {dateTime(ev.at)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="min-h-[320px] overflow-hidden">
            <div className="h-full min-h-[320px]">
              <MapView markers={markers} center={mapCenter(trip)} zoom={13} />
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

function buildMarkers(trip: TripDetail | undefined): MapMarker[] {
  if (!trip) return [];
  const out: MapMarker[] = [];
  if (trip.origin) out.push({ id: 'origin', lon: trip.origin.lon, lat: trip.origin.lat, kind: 'trip', label: 'Origen' });
  if (trip.destination)
    out.push({ id: 'dest', lon: trip.destination.lon, lat: trip.destination.lat, kind: 'trip', label: 'Destino' });
  if (trip.driverLocation)
    out.push({ id: 'driver', lon: trip.driverLocation.lon, lat: trip.driverLocation.lat, kind: 'driver', label: 'Conductor' });
  return out;
}

function mapCenter(trip: TripDetail | undefined): { lon: number; lat: number } | undefined {
  const p = trip?.driverLocation ?? trip?.origin ?? trip?.destination;
  return p ? { lon: p.lon, lat: p.lat } : undefined;
}
