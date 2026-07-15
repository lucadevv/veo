'use client';

import { use, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Armchair,
  Lock,
  MapPin,
  Star,
  UserRound,
  XCircle,
} from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { AdminCarpoolDetailView, AdminCarpoolPassenger } from '@/lib/api/schemas';
import { useCancelCarpool, useCarpoolDetail } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { money, dateTime } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { MapView, type MapMarker } from '@/components/map/lazy-map';

/**
 * DETALLE de un carpool (frame veo.pen m93bTI) — panel finance/carpooling. Fiel al board: Recorrido (mapa +
 * paradas) + Asientos (ocupación + pasajeros) + Reparto de costo COST-SHARE en la columna izquierda; Estado +
 * Conductor + acción de CANCELAR en la derecha. TODO dato REAL de booking-service.
 *
 * HONESTIDAD DE DATOS (lo que el board muestra pero NO tiene fuente en estos seams → se OMITE, no se inventa):
 *  - Nombres de distrito ("Miraflores · Parque Kennedy") y "sube Ana": booking guarda lat/lon + H3, no nombres →
 *    se muestran COORDS.
 *  - "8.4 km · 31 min": la distancia/duración no se persiste (el cost-cap la calcula al publicar, no la guarda).
 *  - "Fee VEO (12%)" + "Payout al conductor": el fee vive en payment (commission) y el payout de carpooling no
 *    está definido en booking → se muestran los datos cost-share DERIVABLES (por asiento / reparten / total).
 *  - "Ahorro compartido 42%": requiere la tarifa individual equivalente (no computada) → card OMITIDA.
 *  - Acciones "Ver en vivo" / "Contactar conductor" / "Cerrar cupos": sin seam admin real → OMITIDAS. Solo
 *    "Cancelar carpool" tiene transición real (máquina → CANCELADO) y se construye.
 */

/** Estado de la oferta → chip (label + tono del theme). Cubre TODO el enum (el detalle puede venir en cualquiera). */
const STATUS_CHIP: Record<AdminCarpoolDetailView['estado'], { label: string; className: string }> = {
  BORRADOR: { label: 'Borrador', className: 'bg-surface-2 text-ink-muted' },
  PUBLICADO: { label: 'Publicado', className: 'bg-brand/12 text-brand' },
  PARCIALMENTE_RESERVADO: { label: 'Reservando', className: 'bg-brand/12 text-brand' },
  LLENO: { label: 'Completo', className: 'bg-warn/[0.12] text-warn' },
  EN_RUTA: { label: 'En curso', className: 'bg-success/[0.12] text-success' },
  COMPLETADO: { label: 'Completado', className: 'bg-surface-2 text-ink-muted' },
  CANCELADO: { label: 'Cancelado', className: 'bg-danger/[0.12] text-danger' },
};

/** Modo de reserva → etiqueta legible (fiel al board: chip "Modo"). */
const MODO_LABEL: Record<AdminCarpoolDetailView['modoReserva'], string> = {
  INSTANT_BOOKING: 'Instantáneo',
  REVISION_CADA_SOLICITUD: 'Con revisión',
};

/** Estados desde los que el admin puede CANCELAR (pre-EN_RUTA) — espeja CANCELABLE_STATES del backend. */
const CANCELABLE = new Set<AdminCarpoolDetailView['estado']>([
  'BORRADOR',
  'PUBLICADO',
  'PARCIALMENTE_RESERVADO',
  'LLENO',
]);

function coord(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function initials(name: string | null): string {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

export default function CarpoolDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const short = id.slice(0, 8);
  const user = useSession();
  const query = useCarpoolDetail(id);
  const detail = query.data;

  const markers = useMemo<MapMarker[]>(() => buildMarkers(detail), [detail]);
  const route = useMemo(() => buildRoute(detail), [detail]);

  // 403 de presentación: el overlay/rol no concede finance:view (el admin-bff igual re-autoriza server-side).
  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Carpool"
          breadcrumbs={[
            { label: 'Carpooling', href: '/finance/carpooling' },
            { label: `#${short}` },
          ]}
        />
        <PermissionState className="flex-1" section="Carpooling" permission="finance:view" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`Carpool #${short}`}
        breadcrumbs={[
          { label: 'Carpooling', href: '/finance/carpooling' },
          { label: `#${short}` },
        ]}
        actions={
          detail ? (
            <span
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold',
                STATUS_CHIP[detail.estado].className,
              )}
            >
              {STATUS_CHIP[detail.estado].label}
            </span>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="grid gap-[18px] p-7 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-[560px] rounded-[20px]" />
          <Skeleton className="h-[560px] rounded-[20px]" />
        </div>
      ) : query.isError ? (
        query.error instanceof ApiError && query.error.status === 404 ? (
          <EmptyState
            className="m-7"
            icon={<MapPin className="size-6" aria-hidden />}
            title="Carpool no encontrado"
            description="Este viaje compartido ya no está disponible."
          />
        ) : (
          <ErrorState onRetry={() => void query.refetch()} className="m-7" />
        )
      ) : detail ? (
        <div className="stagger grid flex-1 gap-[18px] overflow-y-auto p-7 lg:grid-cols-[1fr_360px] lg:items-start">
          {/* Columna izquierda: Recorrido · Asientos · Reparto de costo */}
          <div className="flex flex-col gap-[18px]">
            <RecorridoCard detail={detail} markers={markers} route={route} />
            <AsientosCard detail={detail} />
            <RepartoCard detail={detail} />
          </div>

          {/* Columna derecha: Estado · Conductor · Cancelar */}
          <div className="flex flex-col gap-[18px]">
            <EstadoCard detail={detail} shortId={short} />
            <ConductorCard detail={detail} />
            <CancelAction detail={detail} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Card estándar del detalle (fiel al board: surface, radius 20, padding 22, título Space Grotesk 16/700). */
function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Recorrido: mapa (origen/paradas/destino + línea) + lista de puntos con COORDS (booking no guarda distritos). */
function RecorridoCard({
  detail,
  markers,
  route,
}: {
  detail: AdminCarpoolDetailView;
  markers: MapMarker[];
  route: { lon: number; lat: number }[];
}) {
  const stops = [...detail.stopovers].sort((a, b) => a.orden - b.orden);
  return (
    <Card title="Recorrido">
      <div className="h-[220px] overflow-hidden rounded-[14px] border border-border">
        <MapView
          markers={markers}
          route={route}
          center={{ lon: detail.origenLon, lat: detail.origenLat }}
          zoom={12}
        />
      </div>
      <ol className="flex flex-col gap-0.5">
        <RoutePoint kind="origin" label="Origen" coord={coord(detail.origenLat, detail.origenLon)} />
        {stops.map((s) => (
          <RoutePoint
            key={s.orden}
            kind="stop"
            label={`Parada ${s.orden}`}
            coord={coord(s.lat, s.lon)}
          />
        ))}
        <RoutePoint
          kind="dest"
          label="Destino"
          coord={coord(detail.destinoLat, detail.destinoLon)}
          last
        />
      </ol>
    </Card>
  );
}

/** Punto del recorrido: dot coloreado (origen verde / parada azul / destino rojo) + label + COORD (honesto). */
function RoutePoint({
  kind,
  label,
  coord: coordStr,
  last,
}: {
  kind: 'origin' | 'stop' | 'dest';
  label: string;
  coord: string;
  last?: boolean;
}) {
  const dot =
    kind === 'origin' ? 'bg-success' : kind === 'dest' ? 'bg-danger' : 'bg-brand';
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={cn('mt-1.5 size-[11px] shrink-0 rounded-full', dot)} aria-hidden />
        {!last ? <span className="w-px flex-1 bg-divider" aria-hidden /> : null}
      </div>
      <div className={cn('flex flex-1 items-center justify-between gap-2', last ? '' : 'pb-3')}>
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="font-mono text-xs text-ink-subtle tabular">{coordStr}</span>
      </div>
    </li>
  );
}

/** Asientos: chip de ocupación + tarjetas de pasajeros (nombre PII-gated / id honesto + tramo + precio) + cupos libres. */
function AsientosCard({ detail }: { detail: AdminCarpoolDetailView }) {
  const libres = Math.max(0, detail.asientosDisponibles);
  return (
    <Card
      title="Asientos"
      aside={
        <span className="rounded-full bg-success/[0.12] px-2.5 py-1 text-xs font-bold text-success">
          {detail.asientosReservados} de {detail.asientosTotales} ocupados
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {detail.pasajeros.map((p) => (
          <PassengerCard key={p.bookingId} passenger={p} moneda={detail.moneda} />
        ))}
        {Array.from({ length: libres }).map((_, i) => (
          <div
            key={`libre-${i}`}
            className="flex flex-col gap-2 rounded-[14px] border border-dashed border-brand/50 p-3.5"
          >
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-full bg-surface-2 text-ink-subtle">
                <Armchair className="size-4" aria-hidden />
              </span>
              <span className="text-sm font-semibold text-ink-muted">Disponible</span>
            </div>
            <span className="text-xs text-ink-subtle">Cupo abierto</span>
          </div>
        ))}
        {detail.pasajeros.length === 0 && libres === 0 ? (
          <p className="text-sm text-ink-muted">Sin asientos configurados.</p>
        ) : null}
      </div>
    </Card>
  );
}

/** Tarjeta de un pasajero: avatar + nombre (o id honesto si el rol no ve PII) + tramo (coords) + precio del asiento. */
function PassengerCard({
  passenger,
  moneda,
}: {
  passenger: AdminCarpoolPassenger;
  moneda: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-border bg-surface-2/40 p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/10 text-xs font-bold text-brand">
          {passenger.passengerName ? (
            initials(passenger.passengerName)
          ) : (
            <UserRound className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          {passenger.passengerName ? (
            <p className="truncate text-sm font-semibold text-ink">{passenger.passengerName}</p>
          ) : (
            <p className="truncate font-mono text-xs text-ink-muted">
              {passenger.passengerId.slice(0, 8)}
            </p>
          )}
          <p className="truncate font-mono text-[11px] text-ink-subtle tabular">
            {coord(passenger.pickupLat, passenger.pickupLon)} →{' '}
            {coord(passenger.dropoffLat, passenger.dropoffLon)}
          </p>
        </div>
      </div>
      <span className="font-mono text-[13px] font-bold text-success">
        {money(passenger.precioAcordadoCents)} {moneda !== 'PEN' ? moneda : ''}
      </span>
    </div>
  );
}

/** Reparto de costo · COST-SHARE (derivable): tarifa total + asientos que reparten + por asiento. Fee/payout OMITIDOS. */
function RepartoCard({ detail }: { detail: AdminCarpoolDetailView }) {
  return (
    <Card title="Reparto de costo · COST-SHARE">
      <div className="flex flex-col gap-3">
        <MoneyRow label="Tarifa total del trayecto" value={money(detail.tarifaTotalCents)} strong />
        <MoneyRow label="Asientos que reparten" value={String(detail.asientosQueReparten)} />
        <MoneyRow label="Por asiento" value={money(detail.precioBaseCents)} />
      </div>
      <p className="text-xs text-ink-subtle">
        El conductor fija el precio del asiento; VEO solo evita el lucro (techo costo/km). El service fee y el
        payout se liquidan en Finanzas.
      </p>
    </Card>
  );
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn('text-[13px]', strong ? 'font-semibold text-ink' : 'text-ink-muted')}>
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-[13px] font-bold tabular',
          strong ? 'text-ink' : 'text-ink',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Estado del carpool: estado + salida + asientos + modo + id. */
function EstadoCard({ detail, shortId }: { detail: AdminCarpoolDetailView; shortId: string }) {
  return (
    <Card title="Estado del carpool">
      <div className="flex flex-col gap-3">
        <InfoRow label="Estado">
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold',
              STATUS_CHIP[detail.estado].className,
            )}
          >
            {STATUS_CHIP[detail.estado].label}
          </span>
        </InfoRow>
        <InfoRow label="Salida">
          <span className="text-[13px] font-semibold text-ink tabular">
            {dateTime(detail.fechaHoraSalida)}
          </span>
        </InfoRow>
        <InfoRow label="Asientos">
          <span className="font-mono text-sm font-semibold text-ink tabular">
            {detail.asientosReservados} / {detail.asientosTotales}
          </span>
        </InfoRow>
        <InfoRow label="Modo">
          <span className="rounded-full bg-brand/12 px-2.5 py-1 text-xs font-semibold text-brand">
            {MODO_LABEL[detail.modoReserva]}
          </span>
        </InfoRow>
        <InfoRow label="ID">
          <span className="font-mono text-sm font-semibold text-ink">{shortId}</span>
        </InfoRow>
      </div>
    </Card>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[13px] text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

/** Conductor: avatar + nombre (o id honesto) + vehículo (o "—") + rating (si hay). Degradación honesta si null. */
function ConductorCard({ detail }: { detail: AdminCarpoolDetailView }) {
  const { driver, vehicle } = detail;
  return (
    <Card title="Conductor">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand/10 font-display text-base font-semibold text-brand">
          {initials(driver.name)}
        </span>
        <div className="min-w-0 flex-1">
          {driver.name ? (
            <p className="truncate text-sm font-semibold text-ink">{driver.name}</p>
          ) : (
            <p className="truncate font-mono text-xs text-ink-muted">{driver.id.slice(0, 8)}</p>
          )}
          <p className="truncate text-xs text-ink-muted">
            {vehicle ? `${vehicle.make} ${vehicle.model} · ${vehicle.plate}` : 'Vehículo no disponible'}
          </p>
        </div>
        {driver.averageRating != null ? (
          <span className="flex items-center gap-1">
            <Star className="size-3.5 text-warn" aria-hidden />
            <span className="font-mono text-[13px] font-bold text-ink tabular">
              {driver.averageRating.toFixed(1)}
            </span>
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * CANCELAR carpool (frame HhcYD) — acción DESTRUCTIVA. Solo con `finance:manage` (espejo del @Permission del bff;
 * la UI refleja, el server autoriza) y sobre estados cancelables (pre-EN_RUTA). Step-up MFA + confirmación con la
 * advertencia del board (libera cupos + avisa a los pasajeros + irreversible). Éxito → toast + vuelta al monitoreo.
 */
function CancelAction({ detail }: { detail: AdminCarpoolDetailView }) {
  const user = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const cancel = useCancelCarpool();

  if (!can(user, 'finance:manage')) return null;
  if (!CANCELABLE.has(detail.estado)) {
    return (
      <p className="flex items-center gap-2 rounded-control border border-border bg-surface-2/60 px-4 py-3 text-xs text-ink-muted">
        <Lock className="size-4 shrink-0" aria-hidden />
        Este carpool ya no se puede cancelar (está en curso o finalizado).
      </p>
    );
  }

  const n = detail.pasajeros.length;
  const pax = n === 1 ? '1 pasajera' : `${n} pasajeras`;
  const cupo = n === 1 ? 'su cupo' : 'el cupo';

  return (
    <StepUpDialog
      icon={XCircle}
      title="¿Cancelar el carpool?"
      description={
        n > 0
          ? `Se cancela el viaje compartido y se libera ${cupo} de las ${pax}, que reciben aviso al instante. Esta acción no se puede deshacer.`
          : 'Se cancela el viaje compartido y se libera el cupo publicado. Esta acción no se puede deshacer.'
      }
      confirmLabel="Sí, cancelar"
      confirmVariant="danger"
      trigger={
        <Button variant="secondary" className="w-full justify-center" loading={cancel.isPending}>
          <XCircle className="size-4 text-danger" aria-hidden />
          Cancelar carpool
        </Button>
      }
      onVerified={async () => {
        await cancel.mutateAsync({ id: detail.id });
        toast({
          tone: 'success',
          title: 'Carpool cancelado',
          description: 'Se liberaron los cupos y se avisó a los pasajeros.',
        });
        router.push('/finance/carpooling');
      }}
    />
  );
}

function buildMarkers(detail: AdminCarpoolDetailView | undefined): MapMarker[] {
  if (!detail) return [];
  const out: MapMarker[] = [
    { id: 'origin', lon: detail.origenLon, lat: detail.origenLat, kind: 'trip', label: 'Origen' },
  ];
  for (const s of detail.stopovers) {
    out.push({ id: `stop-${s.orden}`, lon: s.lon, lat: s.lat, kind: 'driver', label: `Parada ${s.orden}` });
  }
  out.push({ id: 'dest', lon: detail.destinoLon, lat: detail.destinoLat, kind: 'panic', label: 'Destino' });
  return out;
}

function buildRoute(detail: AdminCarpoolDetailView | undefined): { lon: number; lat: number }[] {
  if (!detail) return [];
  const stops = [...detail.stopovers].sort((a, b) => a.orden - b.orden);
  return [
    { lon: detail.origenLon, lat: detail.origenLat },
    ...stops.map((s) => ({ lon: s.lon, lat: s.lat })),
    { lon: detail.destinoLon, lat: detail.destinoLat },
  ];
}
