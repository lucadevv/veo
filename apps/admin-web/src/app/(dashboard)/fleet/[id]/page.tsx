'use client';

import { use } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Circle, Lock } from 'lucide-react';
import type { VehicleView } from '@/lib/api/schemas';
import { useVehicle } from '@/lib/api/queries';
import { segmentLabel, energyLabel } from '@/lib/fleet-labels';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * Detalle de UN vehículo de la flota (GET /fleet/vehicles/:id, ENRIQUECIDO con la ficha del modelSpec — la
 * misma forma que la fila de la lista). El valor de la pantalla es la APTITUD PARA EL MATCH: el operador ve de
 * un vistazo si el vehículo tiene la ficha que el dispatch exige (segmento + asientos + año), y si no, POR QUÉ
 * el dispatch lo dejaría pasar en fail-open y CÓMO arreglarlo. Vive dentro de (dashboard) → hereda el layout
 * autenticado por JWT; el admin-bff re-autoriza `fleet:view` server-side (la UI solo refleja).
 */
export default function VehicleDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const query = useVehicle(id);
  const vehicle = query.data;

  const breadcrumbs = [
    { label: 'Flota' },
    { label: 'Vehículos', href: '/fleet' },
    { label: vehicle?.plate ?? id.slice(0, 8) },
  ];

  if (!can(user, 'fleet:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Vehículo" breadcrumbs={breadcrumbs} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para ver este vehículo."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={vehicle?.plate ?? `Vehículo ${id.slice(0, 8)}`}
        breadcrumbs={breadcrumbs}
        actions={vehicle ? <StatusPill status={vehicle.status} /> : null}
      />

      {query.isLoading ? (
        <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <Skeleton className="h-40 lg:col-span-2" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : vehicle ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 lg:p-6">
          <DispatchReadiness vehicle={vehicle} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Identificación</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Placa" value={vehicle.plate} mono />
                <Detail label="Marca" value={vehicle.brand || '—'} />
                <Detail label="Modelo" value={vehicle.model || '—'} />
                <Detail label="Año" value={vehicle.year ? String(vehicle.year) : '—'} />
                <Detail label="Color" value={vehicle.color || '—'} />
                <div>
                  <dt className="text-xs text-ink-muted">Conductor</dt>
                  <dd className="mt-0.5">
                    {vehicle.driverId ? (
                      <Link
                        href={`/ops/drivers/${vehicle.driverId}`}
                        className="font-mono text-accent hover:underline"
                      >
                        {vehicle.driverId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-ink-muted">Sin conductor</span>
                    )}
                  </dd>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Ficha técnica del match</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Segmento" value={segmentLabel(vehicle.segment)} />
                <Detail label="Asientos" value={vehicle.seats ? String(vehicle.seats) : '—'} />
                <Detail label="Tipo" value={vehicle.vehicleType || '—'} />
                <Detail label="Categoría MTC" value={vehicle.mtcCategory || '—'} />
                <Detail label="Energía" value={energyLabel(vehicle.energySource)} />
                <Detail
                  label="Eficiencia (ref.)"
                  value={vehicle.efficiency != null ? String(vehicle.efficiency) : '—'}
                />
                <p className="col-span-2 text-xs text-ink-subtle">
                  La energía es informativa: el precio del viaje usa la energía de la CLASE de la oferta, no la
                  del vehículo. Lo que decide el match es segmento + asientos + año.
                </p>
              </CardContent>
            </Card>
          </div>
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

type ReadyState = 'ok' | 'warn';

/** Chip de readiness de un campo de la ficha: verde si está, ámbar si falta (espeja el patrón del detalle de conductor). */
function ReadyChip({ label, state }: { label: string; state: ReadyState }) {
  const cfg = {
    ok: { Icon: Check, cls: 'bg-success/10 text-success' },
    warn: { Icon: AlertTriangle, cls: 'bg-warn/10 text-warn' },
  } as const;
  const { Icon, cls } = cfg[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

/**
 * APTITUD PARA EL DISPATCH: el verdadero valor de la pantalla. El dispatch deja pasar (fail-open) a un vehículo
 * al que le falte segmento, asientos o año (driver-pool: `seats || segment || vehicleYear`). Reflejamos ESOS
 * tres como chips, y si falta alguno explicamos la consecuencia (puede recibir ofertas para las que no califica)
 * y la remediación (completar la ficha del modelo). La energía NO entra: el dispatch la ignora.
 */
function DispatchReadiness({ vehicle }: { vehicle: VehicleView }) {
  const checks: { label: string; ready: boolean }[] = [
    { label: 'Segmento', ready: !!vehicle.segment },
    { label: 'Asientos', ready: !!vehicle.seats },
    { label: 'Año', ready: !!vehicle.year },
  ];
  const faltan = checks.filter((c) => !c.ready).map((c) => c.label.toLowerCase());
  const apto = faltan.length === 0;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 lg:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Aptitud para el match de ofertas</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {apto
              ? 'El vehículo tiene la ficha que el dispatch necesita para asignarlo a la oferta correcta.'
              : 'El dispatch dejaría pasar este vehículo en fail-open: puede recibir ofertas para las que no califica.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {checks.map((c) => (
            <ReadyChip key={c.label} label={c.label} state={c.ready ? 'ok' : 'warn'} />
          ))}
        </div>
      </div>

      {apto ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-success">
          <Check className="size-3.5" aria-hidden />
          Listo para operar en el match.
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-muted">
          <Circle className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
          <span>
            Falta <strong className="text-ink">{faltan.join(', ')}</strong>. Completá o corregí la ficha del
            modelo en <span className="text-ink">Flota › Modelos</span> para cerrar el eslabón vehículo↔config.
          </span>
        </p>
      )}
    </div>
  );
}
