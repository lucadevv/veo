'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Paperclip,
  Phone,
  ShieldAlert,
  ShieldPlus,
  Siren,
  Video,
} from 'lucide-react';
import { usePanic, usePanicAction, useTrip } from '@/lib/api/queries';
import { dateTime, money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
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

/** Cronómetro "tiempo transcurrido" desde el disparo (HH:MM:SS), refrescado cada segundo. */
function elapsed(fromIso: string, now: number): string {
  const t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function initials(name: string | null | undefined): string {
  if (!name) return '•';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '•';
}

const MODE_LABEL: Record<string, string> = { FIXED: 'Fijo', PUJA: 'Puja' };

/** Clases de un Link/anchor estilado como Button secondary de ancho completo (Button no soporta asChild). */
const LINK_BTN =
  'inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-control border border-border bg-surface-2 px-4 text-sm font-semibold text-ink transition-colors hover:border-border-strong active:scale-[0.97]';

export default function PanicDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const user = useSession();
  const { toast } = useToast();
  const query = usePanic(id);
  const action = usePanicAction();
  const panic = query.data;
  const trip = useTrip(panic?.tripId ?? '').data;

  // Cronómetro (solo activo si el incidente sigue abierto).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!panic || panic.resolvedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [panic]);

  const topbar = (
    <PageHeader
      title="Centro de pánico"
      breadcrumbs={[
        { label: 'Seguridad' },
        { label: 'Pánicos', href: '/security/panics' },
        { label: id.slice(0, 8) },
      ]}
    />
  );

  if (!can(user, 'panics:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <EmptyState className="flex-1" title="Acceso restringido" description="Necesitas el rol correspondiente." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}
      {query.isLoading ? (
        <div className="grid gap-4 p-6 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : !panic ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
          {/* Cabecera del incidente */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Link
              href="/security/panics"
              className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface text-ink-muted transition-colors hover:bg-surface-2"
              aria-label="Volver a la cola de pánicos"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
            <h1 className="font-mono text-xl font-bold text-ink">Pánico #{id.slice(0, 8)}</h1>
            {panic.passengerName ? (
              <span className="text-xl font-semibold text-ink-muted">· {panic.passengerName}</span>
            ) : null}
            <StatusPill status={panic.status} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            {/* Columna principal */}
            <div className="flex min-w-0 flex-col gap-4">
              <MapCard panic={panic} trip={trip} />
              <CameraCard driverName={panic.driverName} />
              <TimelineCard panic={panic} />
            </div>

            {/* Sidebar */}
            <div className="stagger flex flex-col gap-4">
              <IncidentStateCard panic={panic} elapsedStr={elapsed(panic.triggeredAt, now)} />
              <PeopleCard panic={panic} />
              <TripContextCard panic={panic} trip={trip} />

              {/* Acciones de respuesta */}
              <div className="flex flex-col gap-2.5">
                {can(user, 'panics:ack') && !panic.acknowledgedAt ? (
                  <ConfirmDialog
                    trigger={
                      <Button variant="primary" className="w-full">
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
                {can(user, 'panics:ack') ? (
                  <ConfirmDialog
                    trigger={
                      <Button variant={panic.dispatchedAt ? 'secondary' : 'primary'} className="w-full" disabled={!!panic.dispatchedAt}>
                        <ShieldPlus className="size-4" aria-hidden />
                        {panic.dispatchedAt ? 'Unidad despachada' : 'Despachar unidad'}
                      </Button>
                    }
                    title="Despachar unidad de respuesta"
                    description="Registrás que se despachó una unidad de respuesta a la ubicación del incidente."
                    confirmLabel="Despachar"
                    onConfirm={async () => {
                      await action.mutateAsync({ id, action: 'dispatch' });
                      toast({ tone: 'success', title: 'Unidad despachada' });
                    }}
                  />
                ) : null}
                {can(user, 'live:view') ? (
                  <Link href={`/media?trip=${panic.tripId}`} className={LINK_BTN}>
                    <Video className="size-4" aria-hidden />
                    Ver cámara en vivo
                  </Link>
                ) : null}
                {panic.passengerPhone ? (
                  <a href={`tel:${panic.passengerPhone}`} className={LINK_BTN}>
                    <Phone className="size-4" aria-hidden />
                    Contactar pasajero
                  </a>
                ) : null}
                {can(user, 'panics:ack') ? (
                  <PanicEvidenceDialog
                    id={id}
                    trigger={
                      <Button variant="secondary" className="w-full">
                        <Paperclip className="size-4" aria-hidden />
                        Adjuntar evidencia
                      </Button>
                    }
                  />
                ) : null}
                {can(user, 'panics:resolve') && !panic.resolvedAt ? (
                  <PanicResolveDialog
                    id={id}
                    trigger={
                      <Button variant="secondary" className="w-full">
                        <CheckCircle2 className="size-4" aria-hidden />
                        Marcar resuelto
                      </Button>
                    }
                  />
                ) : null}
                {can(user, 'panics:ack') ? (
                  <ConfirmDialog
                    trigger={
                      <Button
                        className={cn(
                          'w-full border border-danger/40 bg-transparent text-danger hover:bg-danger/10',
                        )}
                        disabled={!!panic.escalatedAt}
                      >
                        <Siren className="size-4" aria-hidden />
                        {panic.escalatedAt ? 'Escalado a autoridades' : 'Escalar a autoridades'}
                      </Button>
                    }
                    title="Escalar a autoridades"
                    description="Registrás que el incidente fue escalado a las autoridades competentes. Queda en la auditoría inmutable."
                    confirmLabel="Escalar"
                    onConfirm={async () => {
                      await action.mutateAsync({ id, action: 'escalate' });
                      toast({ tone: 'success', title: 'Escalado a autoridades' });
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type Panic = NonNullable<ReturnType<typeof usePanic>['data']>;
type Trip = NonNullable<ReturnType<typeof useTrip>['data']>;

function MapCard({ panic, trip }: { panic: Panic; trip: Trip | undefined }) {
  const origin = trip?.origin ?? null;
  const route = origin ? [origin, panic.geo] : undefined;
  const markers: MapMarker[] = [
    ...(origin
      ? [{ id: 'origin', lon: origin.lon, lat: origin.lat, kind: 'trip' as const, label: 'Origen del viaje' }]
      : []),
    { id: 'panic', lon: panic.geo.lon, lat: panic.geo.lat, kind: 'panic' as const, label: 'Ubicación del pánico' },
  ];
  const center = origin
    ? { lon: (origin.lon + panic.geo.lon) / 2, lat: (origin.lat + panic.geo.lat) / 2 }
    : panic.geo;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Ubicación en vivo</p>
        {trip?.originLabel ? (
          <span className="truncate text-xs text-ink-muted">{trip.originLabel}</span>
        ) : null}
      </div>
      <div className="mt-3 h-[300px] shrink-0">
        <MapView markers={markers} route={route} center={center} zoom={origin ? 12 : 14} />
      </div>
    </Card>
  );
}

/** Cámara en vivo: el acceso al video es SOBERANO + doble autorización (Ley 29733). No se embebe un feed
 *  falso — se enlaza al flujo real de "Acceso a video". Honesto: el video vive en infra propia (MinIO WORM). */
function CameraCard({ driverName }: { driverName: string | null }) {
  return (
    <Card>
      <div className="flex items-center justify-between px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Cámara en vivo</p>
      </div>
      <CardContent className="p-4">
        <div className="grid size-full min-h-[120px] place-items-center rounded-xl border border-border bg-ink/[0.03] p-4 text-center">
          <div className="flex flex-col items-center gap-2">
            <Video className="size-6 text-ink-subtle" aria-hidden />
            <p className="text-sm text-ink-muted">
              {driverName ? `Cámara del viaje de ${driverName}.` : 'Cámara del viaje en curso.'}
            </p>
            <Link
              href="/media"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-control border border-border bg-surface-2 px-3 text-sm font-semibold text-ink transition-colors hover:border-border-strong active:scale-[0.97]"
            >
              <Video className="size-4" aria-hidden />
              Solicitar acceso al video
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TimelineCard({ panic }: { panic: Panic }) {
  const steps: { label: string; at: string | null }[] = [
    { label: 'Botón de pánico activado', at: panic.triggeredAt },
    { label: 'Operador notificado', at: panic.acknowledgedAt },
    { label: 'Unidad de respuesta despachada', at: panic.dispatchedAt },
    { label: 'Escalado a autoridades', at: panic.escalatedAt },
    { label: 'Incidente resuelto', at: panic.resolvedAt },
  ];
  return (
    <Card>
      <div className="px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Línea de tiempo del incidente</p>
      </div>
      <CardContent className="p-4">
        <ol className="flex flex-col">
          {steps.map((s, i) => {
            const done = !!s.at;
            const last = i === steps.length - 1;
            return (
              <li key={s.label} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full',
                      i === 0 ? 'bg-danger text-danger-on' : done ? 'bg-success text-success-on' : 'bg-surface-2',
                    )}
                    aria-hidden
                  >
                    {done ? <CheckCircle2 className="size-3" /> : null}
                  </span>
                  {!last ? (
                    <span className={cn('w-px flex-1', done ? 'bg-success/40' : 'bg-border')} aria-hidden />
                  ) : null}
                </div>
                <div className={cn('pb-4', last && 'pb-0')}>
                  <p className={cn('text-sm font-medium', done ? 'text-ink' : 'text-ink-subtle')}>
                    {s.label}
                  </p>
                  <p className="font-mono text-xs text-ink-muted">{s.at ? dateTime(s.at) : '—'}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function IncidentStateCard({ panic, elapsedStr }: { panic: Panic; elapsedStr: string }) {
  // Incidente abierto (sin resolver): la tarjeta se tinta de alerta y el cronómetro sube a número-display —
  // el tiempo corriendo es EL dato urgente del vistazo (ritmo En Vivo). Resuelto → neutro.
  const open = !panic.resolvedAt;
  return (
    <Card className={cn(open && 'border-danger/25 bg-danger/[0.04]')}>
      <div className="px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Estado del incidente</p>
      </div>
      {open ? (
        <div className="px-4 pt-3.5">
          <p className="text-[13px] font-medium text-ink-muted">Tiempo transcurrido</p>
          <p className="mt-1 font-display text-[34px] font-bold leading-none tracking-[-1.2px] tabular text-danger">
            {elapsedStr}
          </p>
        </div>
      ) : null}
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm">
        {/* Tipo/Origen/Severidad son CONSTANTES del diseño VEO (pánico OCULTO por botón engañoso, siempre
            urgente) — no campos inventados. Operador a cargo = quien reconoció. */}
        <Row k="Tipo" v="Pánico oculto" tone="accent" />
        <Row k="Severidad" v="Alta" tone="danger" />
        {open ? null : <Row k="Tiempo transcurrido" v="Cerrado" mono />}
        <Row k="Origen" v="Botón oculto" />
        <Row k="Operador a cargo" v={panic.acknowledgedBy ?? '—'} />
      </CardContent>
    </Card>
  );
}

function PeopleCard({ panic }: { panic: Panic }) {
  return (
    <Card>
      <div className="px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Personas</p>
      </div>
      <CardContent className="flex flex-col gap-3 p-4">
        <Party eyebrow="PASAJERO" name={panic.passengerName} fallbackId={panic.passengerId} sub={panic.passengerPhone} />
        <div className="h-px bg-divider" />
        <Party eyebrow="CONDUCTOR" name={panic.driverName} fallbackId={panic.driverId ?? '—'} sub={null} />
      </CardContent>
    </Card>
  );
}

function TripContextCard({ panic, trip }: { panic: Panic; trip: Trip | undefined }) {
  const ruta =
    trip?.originLabel && trip?.destinationLabel
      ? `${trip.originLabel} → ${trip.destinationLabel}`
      : '—';
  return (
    <Card>
      <div className="px-4 pt-4">
        <p className="text-sm font-semibold text-ink">Contexto del viaje</p>
      </div>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm">
        <Row k="Viaje" v={panic.tripId.slice(0, 8)} mono />
        <Row k="Modo" v={trip ? (MODE_LABEL[trip.dispatchMode ?? ''] ?? '—') : '—'} />
        <div className="col-span-2">
          <dt className="text-xs text-ink-muted">Ruta</dt>
          <dd className="truncate text-ink">{ruta}</dd>
        </div>
        <Row k="Tarifa" v={trip ? money(trip.fareCents) : '—'} mono />
      </CardContent>
    </Card>
  );
}

function Row({
  k,
  v,
  mono,
  tone,
}: {
  k: string;
  v: string;
  mono?: boolean;
  tone?: 'accent' | 'danger';
}) {
  const toneCls = tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return (
    <div>
      <dt className="text-xs text-ink-muted">{k}</dt>
      <dd className={cn(mono ? 'font-mono tabular' : '', 'font-medium', toneCls)}>{v}</dd>
    </div>
  );
}

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
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/10 text-[12px] font-semibold text-accent">
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
