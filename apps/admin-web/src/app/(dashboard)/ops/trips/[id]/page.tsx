'use client';

import { useMemo, use } from 'react';
import Link from 'next/link';
import { Archive, ArrowRight, ShieldCheck } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import { useTrip } from '@/lib/api/queries';
import type { TripDetail } from '@/lib/api/schemas';
import { dateTime, duration, money } from '@/lib/formatters';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useRequestAccess } from '@/lib/use-request-access';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { TripStatusBadge, isActiveTrip } from '@/components/trips/status-badge';
import { dispatchModeLabel } from '@/components/trips/mode-pill';
import { MapView, type MapMarker } from '@/components/map/lazy-map';
import { decodePolyline } from '@/lib/map/polyline';

/** Detalle de viaje fiel al frame UNyIW: Ruta + Línea de tiempo (izq) · Tarifa + personas + acciones (der). */
export default function TripDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const short = id.slice(0, 8);
  const user = useSession();
  const canView = can(user, 'trips:view');
  const requestAccess = useRequestAccess();
  const query = useTrip(canView ? id : '');
  const trip = query.data;

  const markers = useMemo<MapMarker[]>(() => buildMarkers(trip), [trip]);
  // Trazado real de la ruta (routePolyline del bff, codificada OSRM) → puntos lon/lat del MapView.
  const route = useMemo(
    () =>
      trip?.routePolyline
        ? decodePolyline(trip.routePolyline).map(([lon, lat]) => ({ lon, lat }))
        : undefined,
    [trip?.routePolyline],
  );

  const topbar = (
    <AdminTopbar
      title={`Viaje #${short}`}
      breadcrumb={
        <span className="flex items-center gap-1.5">
          <Link href="/ops/trips" className="transition-colors hover:text-ink">
            Viajes
          </Link>
          <span className="text-ink-subtle">/</span>
          <span className="text-ink-muted">#{short}</span>
        </span>
      }
      actions={trip ? <TripStatusBadge status={trip.status} /> : null}
    />
  );

  // Gate de permiso (paridad con la lista): sin `trips:view`, PermissionState con solicitar-acceso — NO el
  // ErrorState genérico con retry que loopea sobre el 403.
  if (!canView) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Viajes"
          permission="trips:view"
          onRequest={() => requestAccess('trips:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}

      {query.isLoading ? (
        <div className="grid gap-[18px] p-7 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-[520px] rounded-[20px]" />
          <Skeleton className="h-[520px] rounded-[20px]" />
        </div>
      ) : query.isError ? (
        // Degradación honesta: la LISTA sale de una proyección (read-model) que puede retener viajes purgados;
        // el DETALLE lee el dueño autoritativo (trip-service gRPC). Un 404 = "el viaje ya no existe" (no reintentar);
        // cualquier otro error = 5xx real → ErrorState con reintento.
        query.error instanceof ApiError && query.error.status === 404 ? (
          <EmptyState
            className="m-7"
            icon={<Archive className="size-6" aria-hidden />}
            title="Viaje no disponible"
            description="Este viaje ya no está en el sistema. Si lo viste en el listado, puede tardar unos minutos en desaparecer."
          />
        ) : query.error instanceof ApiError && query.error.status === 403 ? (
          // Permiso revocado a mitad de sesión → PermissionState, no un retry que loopea sobre el 403.
          <PermissionState
            className="flex-1"
            section="Viajes"
            permission="trips:view"
            onRequest={() => requestAccess('trips:view')}
          />
        ) : (
          <ErrorState onRetry={() => void query.refetch()} className="m-7" />
        )
      ) : trip ? (
        <div className="stagger grid flex-1 gap-[18px] overflow-y-auto p-7 lg:grid-cols-[1fr_360px] lg:items-start">
          {/* Columna izquierda: Ruta + Línea de tiempo */}
          <div className="flex flex-col gap-[18px]">
            <Card title="Ruta">
              <div className="h-[260px] overflow-hidden rounded-[14px] border border-border">
                {/* Ruta en brand (no el danger default del MapView: rojo = trayecto de pánico). */}
                <MapView
                  markers={markers}
                  route={route}
                  routeColor="#0075A9"
                  center={mapCenter(trip)}
                  zoom={13}
                />
              </div>
              <div className="flex items-center gap-3">
                <Endpoint eyebrow="ORIGEN" point={trip.origin} label={trip.originLabel} />
                <ArrowRight className="size-[18px] shrink-0 text-ink-subtle" aria-hidden />
                <Endpoint
                  eyebrow="DESTINO"
                  point={trip.destination}
                  label={trip.destinationLabel}
                  align="right"
                />
              </div>
              {/* ETA EN VIVO al destino: solo viaje activo y con dato (null en terminados — no inventar). */}
              {isActiveTrip(trip.status) && trip.etaSeconds != null ? (
                <div className="flex items-center justify-between border-t border-divider pt-3">
                  <span className="text-[13px] text-ink-muted">ETA al destino</span>
                  <span className="font-mono text-[13px] font-semibold text-ink tabular">
                    {duration(trip.etaSeconds)}
                  </span>
                </div>
              ) : null}
            </Card>

            <Card title="Línea de tiempo">
              {trip.timeline.length === 0 ? (
                <p className="text-sm text-ink-muted">Sin eventos registrados.</p>
              ) : (
                <ol className="flex flex-col">
                  {trip.timeline.map((ev, i) => {
                    const last = i === trip.timeline.length - 1;
                    return (
                      <li key={`${ev.status}-${i}`} className="flex gap-3">
                        {/* Rail: punto + conector */}
                        <div className="flex flex-col items-center">
                          <span
                            className={
                              last
                                ? 'mt-1 size-[11px] rounded-full border-2 border-accent bg-surface'
                                : 'mt-1 size-[11px] rounded-full bg-accent'
                            }
                            aria-hidden
                          />
                          {!last ? <span className="w-px flex-1 bg-divider" aria-hidden /> : null}
                        </div>
                        <div
                          className={`flex flex-1 items-center justify-between gap-2 ${last ? '' : 'pb-4'}`}
                        >
                          <TripStatusBadge status={ev.status} />
                          <span className="text-xs text-ink-subtle tabular">{dateTime(ev.at)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          </div>

          {/* Columna derecha: Tarifa + personas + acciones */}
          <div className="flex flex-col gap-[18px]">
            <Card title="Tarifa">
              {/* Honesto: trip-service da el TOTAL cobrado + atributos, NO el desglose por componente
                  (banderazo/km/min). El MODO (Fijo/Puja) sí lo trae (dispatchMode congelado). No se inventa el split S/. */}
              <div className="flex flex-col">
                <FareRow label="Distancia" value={km(trip.distanceMeters)} />
                <FareRow label="Duración" value={duration(trip.durationSeconds)} />
                <FareRow label="Modo" value={dispatchModeLabel(trip.dispatchMode)} />
                <FareRow label="Método de pago" value={trip.paymentMethod ?? '—'} last />
              </div>
              <div className="flex items-center justify-between pt-3">
                <span className="text-sm font-bold text-ink">
                  Total{trip.paymentMethod ? ` · ${trip.paymentMethod}` : ''}
                </span>
                <span className="font-display text-xl font-bold text-accent tabular">
                  {money(trip.fareCents)}
                </span>
              </div>
            </Card>

            <Card title="Personas">
              <Person
                eyebrow="PASAJERO"
                name={trip.passengerName}
                fallbackId={trip.passengerId}
                sub={null}
              />
              <div className="h-px bg-divider" />
              <Person
                eyebrow="CONDUCTOR"
                name={trip.driverName}
                fallbackId={trip.driverId}
                sub={trip.vehiclePlate}
              />
              {trip.driverSuspendedAt != null ? (
                <Badge tone="warn">Conductor suspendido el {dateTime(trip.driverSuspendedAt)}</Badge>
              ) : null}
            </Card>

            {/* Acción REAL: navega a Auditoría filtrada por este viaje. (El board muestra además
                "Reembolsar" y "Cancelar viaje" — acciones financieras/de ciclo de vida sensibles,
                diferidas: la primera vive en el flujo gateado de Finanzas, la segunda no tiene seam admin.) */}
            <Link
              href={`/audit?q=${encodeURIComponent(id)}`}
              className="flex items-center justify-center gap-2 rounded-control border border-border bg-surface px-4 py-3 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2"
            >
              <ShieldCheck className="size-4" aria-hidden />
              Ver en auditoría
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Card estándar del detalle (fiel: surface, radius 20, padding 22, título Space Grotesk 16/700). */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** Fila de tarifa: label izq (muted) · value der (mono). Divider inferior salvo la última. */
function FareRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-[9px] ${last ? '' : 'border-b border-divider'}`}
    >
      <span className="text-[13px] text-ink-muted">{label}</span>
      <span className="font-mono text-[13px] font-semibold text-ink tabular">{value}</span>
    </div>
  );
}

/**
 * Endpoint de ruta: eyebrow (ORIGEN/DESTINO) + DIRECCIÓN legible (reverse-geocode soberano del bff) con la
 * coordenada de subtítulo. Fallback HONESTO: sin label (rol sin geo exacta, sin match o geocoder caído) →
 * la coordenada como texto principal; sin punto → "—". Nunca inventa una dirección.
 */
function Endpoint({
  eyebrow,
  point,
  label,
  align,
}: {
  eyebrow: string;
  point: { lon: number; lat: number } | null;
  label: string | null;
  align?: 'right';
}) {
  const coords = point ? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}` : '—';
  return (
    <div className={`min-w-0 flex-1 ${align === 'right' ? 'text-right' : ''}`}>
      <p className="text-[11px] font-bold tracking-[0.6px] text-ink-subtle">{eyebrow}</p>
      {label ? (
        <>
          <p className="truncate text-[13px] font-medium text-ink">{label}</p>
          <p className="truncate text-[11px] text-ink-subtle tabular">{coords}</p>
        </>
      ) : (
        <p className="truncate text-[13px] font-medium text-ink tabular">{coords}</p>
      )}
    </div>
  );
}

/** Fila de persona: avatar con iniciales + eyebrow + nombre (o id honesto) + subtítulo (placa). */
function Person({
  eyebrow,
  name,
  fallbackId,
  sub,
}: {
  eyebrow: string;
  name: string | null;
  fallbackId: string | null;
  sub: string | null;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-[38px] shrink-0 place-items-center rounded-full bg-accent/10 text-[13px] font-semibold text-accent">
        {initials(name)}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold tracking-[0.4px] text-ink-subtle">{eyebrow}</p>
        {name ? (
          <p className="truncate text-sm font-semibold text-ink">{name}</p>
        ) : (
          <p className="truncate font-mono text-xs text-ink-muted">
            {fallbackId ? fallbackId.slice(0, 8) : 'Sin asignar'}
          </p>
        )}
        {sub ? <p className="truncate text-xs text-ink-muted">{sub}</p> : null}
      </div>
    </div>
  );
}

/** Iniciales (2) del nombre para el avatar; sin nombre → "•". */
function initials(name: string | null): string {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

function km(meters: number | null): string {
  return meters != null ? `${(meters / 1000).toFixed(1)} km` : '—';
}

function buildMarkers(trip: TripDetail | undefined): MapMarker[] {
  if (!trip) return [];
  const out: MapMarker[] = [];
  if (trip.origin)
    out.push({ id: 'origin', lon: trip.origin.lon, lat: trip.origin.lat, kind: 'trip', label: 'Origen' });
  if (trip.destination)
    out.push({ id: 'dest', lon: trip.destination.lon, lat: trip.destination.lat, kind: 'trip', label: 'Destino' });
  if (trip.driverLocation)
    out.push({
      id: 'driver',
      lon: trip.driverLocation.lon,
      lat: trip.driverLocation.lat,
      kind: 'driver',
      label: 'Conductor',
    });
  return out;
}

function mapCenter(trip: TripDetail | undefined): { lon: number; lat: number } | undefined {
  const p = trip?.driverLocation ?? trip?.origin ?? trip?.destination;
  return p ? { lon: p.lon, lat: p.lat } : undefined;
}
