'use client';

import Link from 'next/link';
import {
  Ambulance,
  ArrowLeft,
  Bike,
  Car,
  Lock,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Truck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { PricingMode } from '@veo/shared-types';
import type { BaseFareView, CatalogOffering, CatalogOverride, CatalogView } from '@/lib/api/schemas';
import { useBaseFare, useCatalog, useOfferingMetrics, useReplaceCatalog } from '@/lib/api/queries';
import { offeringDisplayName, withOverride } from '@/lib/catalog';
import { useConfigSave } from '@/lib/use-config-save';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { money, number as formatNumber } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Etiqueta legible del modo de pricing (display). Espejo del panel del catálogo (misma fuente de verdad UI). */
const MODE_LABEL: Record<PricingMode, string> = { PUJA: 'Puja', FIXED: 'Precio fijo' };

// Un <Link> con LOOK de botón (el `Button` del kit no soporta `asChild`/Slot). Mismos tokens que `buttonVariants`
// (accent/surface-2/ghost) para no divergir del look del kit sin hardcodear color.
const LINK_BTN_BASE =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-control text-sm font-semibold ' +
  'transition-[transform,background-color,color,border-color] duration-150 ease-out active:scale-[0.97] ' +
  'focus-visible:outline-none';
const LINK_BTN_VARIANT = {
  primary: 'bg-accent text-accent-on hover:bg-accent-hover',
  secondary: 'bg-surface-2 text-ink border border-border hover:border-border-strong',
  ghost: 'bg-transparent text-ink hover:bg-surface-2',
} as const;

/** La VERTICAL del servicio, legible. El literal viene del contrato (`serviceType`), no de shared-types. */
const SERVICE_TYPE_LABEL: Record<CatalogOffering['serviceType'], string> = {
  RIDE: 'Viaje',
  AMBULANCE: 'Ambulancia',
  TOW: 'Grúa',
  MECHANIC: 'Mecánico',
};

/** Clase de vehículo (pool de matching), legible. */
const VEHICLE_CLASS_LABEL: Record<CatalogOffering['vehicleClass'], string> = {
  CAR: 'Auto',
  MOTO: 'Moto',
};

/** Ícono DERIVADO del dominio (vertical + clase), nunca del id mágico. Mismo criterio que el panel del catálogo. */
function offeringIcon(o: CatalogOffering): LucideIcon {
  switch (o.serviceType) {
    case 'AMBULANCE':
      return Ambulance;
    case 'TOW':
      return Truck;
    case 'MECHANIC':
      return Wrench;
    default:
      return o.vehicleClass === 'MOTO' ? Bike : Car;
  }
}

/**
 * Página-detalle RICA de una oferta (frame veo.pen `HjDvx`). Espeja la anatomía del detalle de liquidación
 * (`payout-detail-view`): topbar (back + breadcrumb + estado) + grid 1fr/columna-derecha con cards. Los datos
 * de Config/Tarifa/Disponibilidad/Estado se REUSAN de `useCatalog` (el mismo catálogo efectivo que la grilla) —
 * cero duplicación de la carga; solo las Métricas 30d son un seam nuevo (`useOfferingMetrics`). "Pausar" reusa
 * la MISMA mutación + step-up del catálogo (`useReplaceCatalog` + `withOverride`); "Editar" vuelve al catálogo
 * (única superficie de guardado, sin duplicar la lógica de edición).
 */
export function OfferingDetailView({ offeringId }: { offeringId: string }) {
  const catalogQuery = useCatalog();
  const catalog = catalogQuery.data;
  const offering = catalog?.offerings.find((o) => o.id === offeringId);

  return (
    <div className="flex h-full flex-col">
      <Topbar offering={offering} />

      {catalogQuery.isLoading ? (
        <DetailSkeleton />
      ) : catalogQuery.isError ? (
        <ErrorState onRetry={() => void catalogQuery.refetch()} className="m-7" />
      ) : !catalog || !offering ? (
        <EmptyState
          className="m-7"
          icon={<Wrench className="size-6" aria-hidden />}
          title="Servicio no encontrado"
          description="Esta oferta no existe en el catálogo. Volvé a la lista de ofertas."
        />
      ) : (
        <Loaded catalog={catalog} offering={offering} offeringId={offeringId} />
      )}
    </div>
  );
}

/* ── Topbar: back (→ /finance/catalog) + breadcrumb + título (nombre de la oferta) + estado ── */
function Topbar({ offering }: { offering: CatalogOffering | undefined }) {
  return (
    <header className="sticky top-0 z-sticky flex items-center justify-between gap-4 border-b border-[color:var(--divider)] bg-surface px-7 py-4">
      <div className="flex items-center gap-3.5">
        <Link
          href="/finance/catalog"
          aria-label="Volver a Ofertas de servicio"
          className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-border bg-bg text-ink-muted transition-colors hover:bg-surface-2"
        >
          <ArrowLeft className="size-[17px]" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <Link href="/finance/catalog" className="transition-colors hover:text-ink-muted">
              Precios
            </Link>
            <span>/</span>
            <Link href="/finance/catalog" className="transition-colors hover:text-ink-muted">
              Ofertas de servicio
            </Link>
          </div>
          <h1 className="truncate font-display text-[21px] font-semibold tracking-[-0.4px] text-ink">
            {offering ? offeringDisplayName(offering) : 'Servicio'}
          </h1>
        </div>
      </div>
      {offering ? <ActiveBadge enabled={offering.enabled} /> : null}
    </header>
  );
}

/** Badge de estado del servicio: Activo (jade) / Inactivo (gris). Fiel al pill verde del board. */
function ActiveBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
        enabled ? 'bg-success/12 text-success' : 'bg-surface-2 text-ink-muted',
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', enabled ? 'bg-success' : 'bg-ink-subtle')}
        aria-hidden
      />
      {enabled ? 'Activo' : 'Inactivo'}
    </span>
  );
}

/* ── Contenido cargado: grid izquierda (config/tarifa/disponibilidad) + derecha (estado/métricas/acciones) ── */
function Loaded({
  catalog,
  offering,
  offeringId,
}: {
  catalog: CatalogView;
  offering: CatalogOffering;
  offeringId: string;
}) {
  const user = useSession();
  const canManage = can(user, 'catalog:manage');
  const baseFareQuery = useBaseFare();
  const metricsQuery = useOfferingMetrics(offeringId);

  const override = catalog.overrides.find((o) => o.id === offeringId);
  const replace = useReplaceCatalog();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el catálogo',
    error: 'No se pudo guardar el catálogo',
  });

  // Pausar/reactivar = el toggle `enabled` del catálogo. REUSA la MISMA mutación + optimistic-locking (CAS) +
  // step-up MFA + `withOverride` que la grilla; preserva modo/precio/params del override al togglear (no los pisa).
  async function setEnabled(enabled: boolean) {
    await save(
      {
        overrides: withOverride(catalog.overrides, {
          id: offeringId,
          enabled,
          mode: override?.mode,
          multiplier: override?.multiplier,
          minFareCents: override?.minFareCents,
          baseFareCents: override?.baseFareCents,
          perKmCents: override?.perKmCents,
          perMinCents: override?.perMinCents,
        }),
        expectedVersion: catalog.version,
      },
      `${offeringDisplayName(offering)} ${enabled ? 'habilitada' : 'deshabilitada'}`,
    );
  }

  return (
    <div className="stagger grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_340px] lg:items-start">
      {/* Columna izquierda: Configuración + Tarifa + Disponibilidad */}
      <div className="flex flex-col gap-[18px]">
        <ConfigCard offering={offering} />
        <TariffCard offering={offering} override={override} baseFare={baseFareQuery.data} />
        <AvailabilityCard offering={offering} />
      </div>
      {/* Columna derecha: Estado + Métricas 30d + Acciones */}
      <div className="flex flex-col gap-[18px]">
        <StatusCard offering={offering} />
        <MetricsCard query={metricsQuery} />
        <ActionsCard
          offering={offering}
          canManage={canManage}
          pending={saving}
          onSetEnabled={setEnabled}
        />
      </div>
    </div>
  );
}

/* ── Card estándar del detalle (mismos tokens que payout-detail: surface, radius 20, padding 22, título 16/700) ── */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** Fila etiqueta ▸ valor. `mono` para slugs/ids; `tag` marca un valor "a medida" (override explícito). */
function InfoRow({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-divider py-3 last:border-b-0">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="flex items-center gap-2 text-right">
        {hint ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-brand">{hint}</span>
        ) : null}
        <span className={cn('text-sm font-semibold text-ink', mono && 'font-mono')}>{value}</span>
      </span>
    </div>
  );
}

/* ── Configuración del servicio: ícono + nombre + subtítulo derivado + config base (modo/vertical/clase/slug) ── */
function ConfigCard({ offering }: { offering: CatalogOffering }) {
  const Icon = offeringIcon(offering);
  const subtitle = `${SERVICE_TYPE_LABEL[offering.serviceType]} · ${VEHICLE_CLASS_LABEL[offering.vehicleClass]}`;
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex items-start gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-display text-base font-semibold text-ink">{offeringDisplayName(offering)}</h2>
          <p className="text-[13px] text-ink-muted">{subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col">
        <InfoRow
          label="Modo de tarifa"
          value={
            offering.modeLocked ? (
              <span className="inline-flex items-center gap-1.5" title="Fijo por la vertical del servicio">
                <Lock className="size-3.5 text-ink-subtle" aria-hidden />
                {MODE_LABEL[offering.mode]}
              </span>
            ) : (
              MODE_LABEL[offering.mode]
            )
          }
        />
        <InfoRow label="Vertical" value={SERVICE_TYPE_LABEL[offering.serviceType]} />
        <InfoRow label="Clase de vehículo" value={VEHICLE_CLASS_LABEL[offering.vehicleClass]} />
        <InfoRow label="Slug" value={offering.id} mono />
      </div>
    </section>
  );
}

/* ── Tarifa: multiplicador + tarifa mínima (EFECTIVOS del contrato) + banderazo/km/min (override o global) ── */
function TariffCard({
  offering,
  override,
  baseFare,
}: {
  offering: CatalogOffering;
  override: CatalogOverride | undefined;
  baseFare: BaseFareView | undefined;
}) {
  // El contrato (`offering.pricing`) SOLO trae multiplier + minFareCents como EFECTIVOS. Banderazo/km/min efectivos
  // NO viajan: solo el OVERRIDE crudo (si el admin lo pisó) o el default GLOBAL de la tarifa base. Honesto: mostramos
  // el override cuando existe (chip "a medida") y, si no, el valor GLOBAL como referencia (no inventamos el efectivo).
  const param = (overrideCents: number | undefined, globalCents: number | undefined) =>
    overrideCents != null
      ? { value: money(overrideCents), hint: 'A medida' }
      : globalCents != null
        ? { value: money(globalCents), hint: 'Global' }
        : { value: '—', hint: undefined };

  const banderazo = param(override?.baseFareCents, baseFare?.baseFareCents);
  const porKm = param(override?.perKmCents, baseFare?.perKmCents);
  const porMin = param(override?.perMinCents, baseFare?.perMinCents);

  return (
    <Card title="Tarifa">
      <div className="flex flex-col">
        <InfoRow label="Multiplicador" value={`× ${offering.pricing.multiplier}`} />
        <InfoRow label="Tarifa mínima" value={money(offering.pricing.minFareCents)} />
        <InfoRow label="Banderazo" value={banderazo.value} hint={banderazo.hint} />
        <InfoRow label="Por km" value={porKm.value} hint={porKm.hint} />
        <InfoRow label="Por minuto" value={porMin.value} hint={porMin.hint} />
      </div>
    </Card>
  );
}

/* ── Disponibilidad: los HECHOS reales del contrato (clase, vertical, capacidad). Sin zonas/horario (sin fuente) ── */
function AvailabilityCard({ offering }: { offering: CatalogOffering }) {
  return (
    <Card title="Disponibilidad">
      <div className="flex flex-col">
        <InfoRow label="Clase de vehículo" value={VEHICLE_CLASS_LABEL[offering.vehicleClass]} />
        <InfoRow label="Vertical" value={SERVICE_TYPE_LABEL[offering.serviceType]} />
        {offering.requires?.minSeats != null ? (
          <InfoRow label="Capacidad mínima" value={`${offering.requires.minSeats} asientos`} />
        ) : null}
      </div>
    </Card>
  );
}

/* ── Estado: badge Activo/Inactivo + publicación + modo ── */
function StatusCard({ offering }: { offering: CatalogOffering }) {
  return (
    <Card title="Estado">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-muted">Publicación</span>
        <ActiveBadge enabled={offering.enabled} />
      </div>
      <div className="flex flex-col">
        <InfoRow label="Modo" value={MODE_LABEL[offering.mode]} />
      </div>
    </Card>
  );
}

/* ── Métricas · 30 días: seam nuevo (trip-service). SOLO datos con fuente real: Viajes + Ingreso (bruto). El
      rating por oferta y el revenue NETO por oferta NO tienen fuente → se omiten (honestidad de datos). ── */
function MetricsCard({ query }: { query: ReturnType<typeof useOfferingMetrics> }) {
  return (
    <Card title="Métricas · 30 días">
      {query.isLoading ? (
        <div className="grid grid-cols-2 gap-3" role="status" aria-label="Cargando métricas">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-muted">No se pudieron cargar las métricas.</p>
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3.5" aria-hidden /> Reintentar
          </Button>
        </div>
      ) : query.data ? (
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Viajes" value={formatNumber(query.data.tripCount)} />
          <Metric
            label="Ingreso"
            value={money(query.data.grossFareCents)}
            caption="Facturación bruta"
          />
        </div>
      ) : null}
    </Card>
  );
}

/** Un número de métrica (valor grande + label + caption honesta opcional). */
function Metric({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-bg px-4 py-3.5">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="font-display text-[26px] font-bold leading-none tracking-[-0.8px] tabular text-ink">
        {value}
      </p>
      {caption ? <p className="text-[10px] text-ink-subtle">{caption}</p> : null}
    </div>
  );
}

/* ── Acciones: Editar (→ catálogo) · Pausar/Reactivar (toggle + step-up) · Auditar (→ /audit) ── */
function ActionsCard({
  offering,
  canManage,
  pending,
  onSetEnabled,
}: {
  offering: CatalogOffering;
  canManage: boolean;
  pending: boolean;
  onSetEnabled: (enabled: boolean) => Promise<void>;
}) {
  const label = offeringDisplayName(offering);
  const willPause = offering.enabled;
  return (
    <Card title="Acciones">
      <div className="flex flex-col gap-2.5">
        {/* Editar = volver al catálogo (única superficie de guardado; no duplicamos la edición acá). */}
        <Link
          href="/finance/catalog"
          title={`Editar ${label}`}
          className={cn(LINK_BTN_BASE, LINK_BTN_VARIANT.primary)}
        >
          <Pencil className="size-4" aria-hidden /> Editar servicio
        </Link>

        {/* Pausar/reactivar = el toggle `enabled` del catálogo, con step-up MFA (acción destructiva-suave). */}
        {canManage ? (
          <StepUpDialog
            title={willPause ? `Pausar ${label}` : `Reactivar ${label}`}
            description={
              willPause
                ? `Los pasajeros dejarán de ver y cotizar ${label}. Cambia el catálogo global y queda auditado.`
                : `Los pasajeros volverán a ver y cotizar ${label}. Cambia el catálogo global y queda auditado.`
            }
            confirmLabel={willPause ? 'Pausar' : 'Reactivar'}
            onVerified={() => onSetEnabled(!offering.enabled)}
            trigger={
              <Button variant="secondary" className="w-full" loading={pending}>
                {willPause ? (
                  <>
                    <Pause className="size-4" aria-hidden /> Pausar servicio
                  </>
                ) : (
                  <>
                    <Play className="size-4" aria-hidden /> Reactivar servicio
                  </>
                )}
              </Button>
            }
          />
        ) : null}

        {/* Auditar = registro de cambios del catálogo (la auditoría no es per-oferta: el overlay se audita
            wholesale por versión; el filtro `q` prefiltra a los cambios de catálogo). */}
        <Link href="/audit?q=offering_catalog" className={cn(LINK_BTN_BASE, LINK_BTN_VARIANT.ghost)}>
          <ScrollText className="size-4" aria-hidden /> Auditar
        </Link>

        {canManage ? (
          <p className="flex items-center gap-1.5 pt-1 text-xs text-ink-subtle">
            <ShieldCheck className="size-3.5" aria-hidden />
            Pausar pide tu TOTP
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/* ── Skeleton de carga (misma grilla que el contenido) ── */
function DetailSkeleton() {
  return (
    <div className="grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_340px] lg:items-start">
      <div className="flex flex-col gap-[18px]">
        <Skeleton className="h-[260px] rounded-[20px]" />
        <Skeleton className="h-[280px] rounded-[20px]" />
      </div>
      <div className="flex flex-col gap-[18px]">
        <Skeleton className="h-[150px] rounded-[20px]" />
        <Skeleton className="h-[150px] rounded-[20px]" />
      </div>
    </div>
  );
}
