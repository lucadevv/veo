'use client';

import { forwardRef, useState } from 'react';
import {
  Ambulance,
  Bike,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Lock,
  RefreshCw,
  Truck,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { solesToCents } from '@veo/utils/money';
import { PricingMode, ServiceType, VehicleClass } from '@veo/shared-types';
import type {
  BaseFareView,
  BidFloorView,
  CatalogOffering,
  CatalogOverride,
  CatalogView,
} from '@/lib/api/schemas';
import { offeringLabel, withOverride } from '@/lib/catalog';
import {
  BID_FLOOR_MAX_SOLES,
  offeringFloorOverrideCents,
  pujaFloorExceedsFixedMin,
  withFloorOverride,
} from '@/lib/bid-floor';
import { useReplaceBidFloor, useReplaceCatalog } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { cn } from '@/lib/cn';
import { formatSolesInput, parseSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { RateInput } from '@/components/config/config-card';
import { Button } from '@/components/ui/button';

/** Etiqueta legible del modo de pricing para el panel (display, no comparación de dominio). */
const MODE_LABEL: Record<PricingMode, string> = { PUJA: 'Puja', FIXED: 'Precio fijo' };

// Espejo del MULTIPLIER_MAX autoritativo (trip-service catalog.dto). El contrato/UI no importan shared-types;
// el valor vive acá como literal documentado. trip-service y el admin-bff RE-validan server-side.
const MULTIPLIER_MAX_UI = 10;

// Topes de cordura de los params POR-OFERTA (ADR 023 §3), en SOLES: ESPEJO de los caps del override en el
// contrato (@veo/api-client: baseFareCents≤20000, perKmCents≤5000, perMinCents≤2000 céntimos) y de la tarifa
// base GLOBAL (base-fare-panel). El admin los edita en soles; se persisten Int en céntimos. `0` es válido
// (Mecánico call-out plano perKm/perMin=0; Grúa sin per-min). trip-service RE-valida server-side.
const MAX_BASE_FARE_SOLES = 200;
const MAX_PER_KM_SOLES = 50;
const MAX_PER_MIN_SOLES = 20;

/**
 * Ícono de la oferta, DERIVADO del dominio (vertical + clase de vehículo), nunca del `id` mágico: las
 * verticales especiales (ambulancia/grúa/mecánico) llevan su ícono; entre las RIDE, MOTO → bici, CAR → auto.
 */
function offeringIcon(o: CatalogOffering): LucideIcon {
  switch (o.serviceType) {
    case ServiceType.AMBULANCE:
      return Ambulance;
    case ServiceType.TOW:
      return Truck;
    case ServiceType.MECHANIC:
      return Wrench;
    default:
      return o.vehicleClass === VehicleClass.MOTO ? Bike : Car;
  }
}

/**
 * Ofertas de servicio (ADR 013 · Fase B / A1). El admin prende/apaga cada oferta y, por oferta, pinea el MODO
 * (PUJA/FIXED, restringido a lo que la oferta permite), ajusta el PRECIO (multiplicador + tarifa mínima FIJA)
 * y —para las ofertas que pujan— el PISO de la PUJA. A1 unifica acá los DOS mínimos que antes vivían partidos
 * (tarifa fija en Catálogo, piso de puja en Precios) con validación cruzada visible. El pasajero ve/cotiza/crea
 * SOLO con lo configurado (server-driven); admin-bff + trip-service re-autorizan y re-validan server-side.
 *
 * El catálogo y el piso de la PUJA son DOS configs distintas (endpoint + versión/CAS propios): cada una tiene
 * su Guardar, su step-up y su optimistic-locking. No se mezclan en un PUT — serían dos mutations no-atómicas.
 *
 * Diseño (veo.pen · "Ofertas de servicio"): UNA tabla PLANA — las ofertas se listan por su `sortOrder`, sin
 * agrupar por eje (calidad/capacidad/especial). Cada fila trae modo (select), multiplicador, los dos mínimos,
 * el switch de disponibilidad y un icon-button de guardado.
 */
/** Datos del piso de la PUJA que necesita UNA fila, o `undefined` si su config (bid-floor) no está disponible. */
interface OfferingFloor {
  /** Override explícito de ESTA oferta (cents), o `null` si cae al default. */
  overrideCents: number | null;
  /** Piso por defecto global (siempre presente cuando el bid-floor cargó). */
  defaultFloorCents: number;
}

export function CatalogPanel({
  catalog,
  bidFloor,
  baseFare,
  onRetryBidFloor,
}: {
  catalog: CatalogView;
  // POSIBLEMENTE undefined: el piso de la PUJA es OTRA config (endpoint + CAS propios). Si su query carga o
  // falla, la lista de ofertas (catálogo) sigue operativa y SOLO la columna del piso degrada (no toda la fila).
  bidFloor: BidFloorView | undefined;
  // Tarifa base GLOBAL (F2.4) — SOLO para el placeholder de los params por-servicio (muestra el número que
  // se usaría si el campo queda vacío). POSIBLEMENTE undefined (su query carga/falla): el placeholder cae a
  // "global" y la edición de params sigue operativa (el valor real lo resuelve el server igual).
  baseFare: BaseFareView | undefined;
  /** Reintenta SOLO la query del bid-floor (la del catálogo tiene su propio retry en el AsyncSection padre). */
  onRetryBidFloor: () => void;
}) {
  const user = useSession();
  const canManage = can(user, 'catalog:manage');
  // El piso de la PUJA es un recurso de PRICING (endpoint /pricing/bid-floor), no de catálogo: se gatea con
  // `pricing:manage` (mapea a los mismos roles que catalog:manage hoy, pero es el permiso semánticamente correcto).
  const canManageFloor = can(user, 'pricing:manage');
  const replace = useReplaceCatalog();
  const replaceBid = useReplaceBidFloor();
  // El mensaje de éxito varía por acción (habilitar/deshabilitar vs precio/modo) → se pasa por-llamada como
  // override de `save`. El copy de conflicto/error es canónico (parametrizado por el sustantivo "el catálogo").
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el catálogo',
    error: 'No se pudo guardar el catálogo',
  });
  // Guardado PROPIO del piso de la PUJA: otra mutation, otra versión/CAS → su useConfigSave separado.
  const { save: saveBid, saving: savingBid } = useConfigSave({
    mutation: replaceBid,
    conflictNoun: 'el piso de la puja',
    error: 'No se pudo guardar el piso de la puja',
  });

  const overrideOf = (id: string): CatalogOverride | undefined =>
    catalog.overrides.find((o) => o.id === id);

  // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió → 409 (toast de conflicto).
  const commit = (next: CatalogOverride, msg: string) =>
    save(
      { overrides: withOverride(catalog.overrides, next), expectedVersion: catalog.version },
      msg,
    );

  async function setEnabled(id: string, enabled: boolean) {
    const ov = overrideOf(id); // preserva modo/precio/params por-servicio al togglear
    await commit(
      {
        id,
        enabled,
        mode: ov?.mode,
        multiplier: ov?.multiplier,
        minFareCents: ov?.minFareCents,
        baseFareCents: ov?.baseFareCents,
        perKmCents: ov?.perKmCents,
        perMinCents: ov?.perMinCents,
      },
      `${offeringLabel(id)} ${enabled ? 'habilitada' : 'deshabilitada'}`,
    );
  }

  // Devuelve el ok del write (true=guardado / false=409 o error) para que `saveRow` haga short-circuit y NO
  // dispare el guardado del piso si el del catálogo falló (dos writes secuenciales, config de dinero).
  function savePricing(next: CatalogOverride): Promise<boolean> {
    return commit(next, `${offeringLabel(next.id)}: precio y modo actualizados`);
  }

  // FULL-REPLACE del overlay del bid-floor con SOLO esta oferta tocada (cents) o quitada (null → usa el default).
  // expectedVersion = la del bidFloor (su propio CAS, distinto del catálogo). Guard: sin bidFloor cargado el
  // editor del piso ni se muestra, así que esto no se invoca — el guard solo satisface al narrowing.
  async function saveFloor(offeringId: string, cents: number | null) {
    if (!bidFloor) return;
    await saveBid(
      {
        defaultFloorCents: bidFloor.defaultFloorCents,
        overrides: withFloorOverride(bidFloor.overrides, offeringId, cents),
        expectedVersion: bidFloor.version,
      },
      `Piso de puja de ${offeringLabel(offeringId)} ${cents === null ? 'restablecido al default' : 'actualizado'}`,
    );
  }

  const activeCount = catalog.offerings.filter((o) => o.enabled).length;
  // Lista PLANA por `sortOrder` (copia — no mutar el array de la query). El diseño no agrupa por eje.
  const rows = [...catalog.offerings].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-4 pt-4">
      {activeCount === 0 ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          Ninguna oferta habilitada: los pasajeros no podrán pedir un viaje hasta que actives al
          menos una.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse">
          <thead className="bg-surface-2">
            <tr className="border-b border-border">
              <th className="w-full py-3 pl-5 pr-3 text-left text-[11px] font-semibold text-ink-subtle">
                Categoría
              </th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-ink-subtle">
                Modo
              </th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-ink-subtle">
                Multiplicador
              </th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-ink-subtle">
                Tarifa mínima
              </th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-ink-subtle">
                Piso de puja
              </th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-ink-subtle">
                Activa
              </th>
              <th className="py-3 pl-3 pr-5" aria-label="Guardar" />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              // El `key` incluye la disponibilidad del bid-floor: cuando su query resuelve (undefined→data),
              // la fila se re-monta y el input del piso re-siembra su estado desde el override ya cargado (sin
              // esto el `useState` inicial — sembrado en '' mientras el piso cargaba — quedaría stale → dirty falso).
              <OfferingRow
                key={`${o.id}:${bidFloor ? 'floor' : 'no-floor'}`}
                offering={o}
                override={overrideOf(o.id)}
                baseFare={baseFare}
                floor={
                  bidFloor
                    ? {
                        overrideCents: offeringFloorOverrideCents(bidFloor, o.id),
                        defaultFloorCents: bidFloor.defaultFloorCents,
                      }
                    : undefined
                }
                canManage={canManage}
                canManageFloor={canManageFloor}
                pending={saving}
                pendingFloor={savingBid}
                onSetEnabled={setEnabled}
                onSavePricing={savePricing}
                onSaveFloor={saveFloor}
                onRetryFloor={onRetryBidFloor}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ReadOnlyNote canManage={canManage} noun="el catálogo" />
    </div>
  );
}

/**
 * Switch accesible (button role="switch"): sirve de estado editable (envuelto en StepUpDialog dispara
 * setEnabled) o de indicador de solo-lectura (disabled). forwardRef para que Radix (DialogTrigger asChild) le
 * inyecte onClick/ref al usarlo como trigger del step-up.
 */
const Switch = forwardRef<
  HTMLButtonElement,
  { checked: boolean; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function Switch({ checked, label, disabled, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none',
        checked ? 'justify-end bg-brand' : 'justify-start border border-border-strong bg-surface-2',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
      {...props}
    >
      <span className="size-5 rounded-full bg-ink" />
    </button>
  );
});

/** Celda tipo RateField (config-card): box con borde + input + sufijo de unidad + error debajo. Sin label (el
 *  encabezado de la columna hace de label). Reusa RateInput (mono/tabular) para el value. */
function RateCell({
  unit,
  error,
  children,
}: {
  unit: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-28">
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md border bg-surface-2 px-2.5 py-1.5 focus-within:border-brand',
          error ? 'border-danger' : 'border-border-strong',
        )}
      >
        {children}
        <span className="shrink-0 text-xs text-ink-subtle">{unit}</span>
      </div>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** Una fila de oferta (tabla): estado + editor de modo + precio + piso de puja + switch, cada uno con su guardado dirty. */
function OfferingRow({
  offering,
  override,
  baseFare,
  floor,
  canManage,
  canManageFloor,
  pending,
  pendingFloor,
  onSetEnabled,
  onSavePricing,
  onSaveFloor,
  onRetryFloor,
}: {
  offering: CatalogOffering;
  override: CatalogOverride | undefined;
  // Tarifa base GLOBAL (o undefined si su query no cargó) → placeholder de los params a medida.
  baseFare: BaseFareView | undefined;
  // undefined = el bid-floor (config propia) no está disponible (loading o error) → la columna del piso degrada.
  floor: OfferingFloor | undefined;
  canManage: boolean;
  canManageFloor: boolean;
  pending: boolean;
  pendingFloor: boolean;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onSavePricing: (next: CatalogOverride) => Promise<boolean>;
  onSaveFloor: (id: string, cents: number | null) => Promise<void>;
  onRetryFloor: () => void;
}) {
  const floorOverrideCents = floor?.overrideCents ?? null;

  const [mode, setMode] = useState<PricingMode>(override?.mode ?? offering.mode);
  const [multiplier, setMultiplier] = useState<string>(override?.multiplier?.toString() ?? '');
  const [minFareSoles, setMinFareSoles] = useState<string>(
    override?.minFareCents != null ? formatSolesInput(override.minFareCents) : '',
  );
  // ADR 023 §3 · params POR-SERVICIO (banderazo/km/min por OFERTA). '' = sin override → cae al global. En SOLES.
  const [baseFareSoles, setBaseFareSoles] = useState<string>(
    override?.baseFareCents != null ? formatSolesInput(override.baseFareCents) : '',
  );
  const [perKmSoles, setPerKmSoles] = useState<string>(
    override?.perKmCents != null ? formatSolesInput(override.perKmCents) : '',
  );
  const [perMinSoles, setPerMinSoles] = useState<string>(
    override?.perMinCents != null ? formatSolesInput(override.perMinCents) : '',
  );
  // Piso de la PUJA: '' = sin override (usa el default), igual que en el panel de Precios.
  const [floorSoles, setFloorSoles] = useState<string>(
    floorOverrideCents != null ? formatSolesInput(floorOverrideCents) : '',
  );
  // ¿Esta oferta ya tiene ALGÚN param a medida? (banderazo/km/min). Marca el chip "a medida" y arranca la fila
  // de detalle ABIERTA — si no tiene ninguno, el detalle empieza colapsado (la mayoría hereda el global).
  const hasParamOverride =
    override?.baseFareCents != null ||
    override?.perKmCents != null ||
    override?.perMinCents != null;
  const [expanded, setExpanded] = useState<boolean>(hasParamOverride);

  // Modo EFECTIVO en vivo (ADR 023): si la oferta está LOCKED (verticales especiales: ambulancia/grúa/mecánico)
  // manda el modo fijo del server (el admin NO lo cambia); si no, el modo elegido en el select (Fijo/Puja,
  // explícito). La puja —y por ende su piso— solo tiene sentido en modo PUJA.
  const effectiveMode: PricingMode = offering.modeLocked ? offering.mode : mode;
  const allowsPuja = effectiveMode === PricingMode.PUJA;

  // Parseo: vacío → undefined (usar el de código). Inválido → bloquea el guardado.
  const multNum = multiplier.trim() === '' ? undefined : Number(multiplier);
  const minFareCents = minFareSoles.trim() === '' ? undefined : solesToCents(Number(minFareSoles));
  // Tope de cordura del multiplicador: corta el dedazo ×100 ANTES de mandar (el BFF y trip-service re-validan
  // server-side con MULTIPLIER_MAX=10 autoritativo). 0 < x ≤ 10.
  const multInvalid =
    multNum !== undefined &&
    (!Number.isFinite(multNum) || multNum <= 0 || multNum > MULTIPLIER_MAX_UI);
  const minFareInvalid =
    minFareCents !== undefined && (!Number.isFinite(minFareCents) || minFareCents < 0);

  // Params por-servicio: '' → undefined (cae al global). `0` es válido. Tope espejo del contrato (en céntimos).
  const baseFareCents =
    baseFareSoles.trim() === '' ? undefined : solesToCents(Number(baseFareSoles));
  const perKmCents = perKmSoles.trim() === '' ? undefined : solesToCents(Number(perKmSoles));
  const perMinCents = perMinSoles.trim() === '' ? undefined : solesToCents(Number(perMinSoles));
  const baseFareInvalid =
    baseFareCents !== undefined &&
    (!Number.isFinite(baseFareCents) || baseFareCents < 0 || baseFareCents > MAX_BASE_FARE_SOLES * 100);
  const perKmInvalid =
    perKmCents !== undefined &&
    (!Number.isFinite(perKmCents) || perKmCents < 0 || perKmCents > MAX_PER_KM_SOLES * 100);
  const perMinInvalid =
    perMinCents !== undefined &&
    (!Number.isFinite(perMinCents) || perMinCents < 0 || perMinCents > MAX_PER_MIN_SOLES * 100);
  const paramInvalid = baseFareInvalid || perKmInvalid || perMinInvalid;
  // La fila de detalle (params a medida) está ABIERTA si el operador la expandió O si hay un param inválido
  // (nunca escondas un error detrás del colapso). El chevron togglea `expanded`; el error la fuerza abierta.
  const detailOpen = expanded || paramInvalid;
  // Placeholder de un param: el valor GLOBAL real (lo que se usa si el campo queda vacío) o "global" si su
  // query aún no cargó. Comunica el fallback SIN que el operador tenga que ir a la pantalla de tarifa base.
  const globalPlaceholder = (cents: number | undefined): string =>
    cents != null ? formatSolesInput(cents) : 'global';

  // Piso de puja: '' = null (sin override). Bounds 1..MAX (espejo del server, igual que el panel de Precios).
  // Sin bidFloor (`floor === undefined`) la columna degrada → no hay draft válido ni dirty (no se puede editar).
  const floorAvailable = floor !== undefined;
  const floorDraftCents = floorSoles.trim() === '' ? null : parseSolesInput(floorSoles);
  const floorInvalid =
    floorAvailable &&
    floorDraftCents !== null &&
    (!Number.isFinite(floorDraftCents) ||
      floorDraftCents < 1 ||
      floorDraftCents > BID_FLOOR_MAX_SOLES * 100);
  // Editable solo si el piso cargó Y hay permiso de pricing → sin eso no puede haber dirty (el input ni se muestra).
  const floorEditable = floorAvailable && canManageFloor;
  const floorDirty = floorEditable && floorDraftCents !== floorOverrideCents;

  const dirty =
    mode !== (override?.mode ?? offering.mode) ||
    (multNum ?? null) !== (override?.multiplier ?? null) ||
    (minFareCents ?? null) !== (override?.minFareCents ?? null) ||
    (baseFareCents ?? null) !== (override?.baseFareCents ?? null) ||
    (perKmCents ?? null) !== (override?.perKmCents ?? null) ||
    (perMinCents ?? null) !== (override?.perMinCents ?? null);

  // Validación cruzada: comparo los mínimos EFECTIVOS (draft válido si lo hay, si no el persistido). El piso
  // efectivo = override ?? default; la tarifa fija efectiva = draft ?? la del catálogo (`pricing` ya es efectivo).
  // Sin bidFloor no hay piso comparable → null (no se advierte) — el cross-warn sigue intacto cuando SÍ está.
  const effFloorCents =
    floor === undefined
      ? null
      : floorDraftCents !== null && !floorInvalid
        ? floorDraftCents
        : (floorOverrideCents ?? floor.defaultFloorCents);
  const effFixedMinCents =
    minFareCents !== undefined && !minFareInvalid ? minFareCents : offering.pricing.minFareCents;
  // crossWarn carga los DOS números ya narrowed (no-null) para el render; null = no se advierte (sin bidFloor,
  // sin allowsPuja, o piso ≤ mínimo fijo). El `effFloorCents !== null` narrowea a number.
  //
  // LIVE (no banner permanente): el aviso solo se muestra mientras el operador EDITA el piso o la mínima de ESTA
  // fila — no sobre datos que ya venían inconsistentes. Sin tocar nada → tabla limpia; al cambiar el valor valida
  // en vivo y desaparece cuando queda coherente. `minTouched` usa el MISMO criterio que el `dirty` de la mínima.
  const minTouched = (minFareCents ?? null) !== (override?.minFareCents ?? null);
  const crossWarn =
    (floorDirty || minTouched) &&
    allowsPuja &&
    effFloorCents !== null &&
    pujaFloorExceedsFixedMin(effFloorCents, effFixedMinCents)
      ? { floorCents: effFloorCents, fixedMinCents: effFixedMinCents }
      : null;

  // UN solo Guardar por fila: salva lo que cambió de CADA config (catálogo y/o piso de puja). Son dos endpoints
  // con su propio CAS, pero el operador no debería ver dos botones — un step-up cubre la acción y cada save
  // mantiene su 409/toast por separado. SHORT-CIRCUIT: si el write del catálogo falla (409/error), NO se dispara
  // el del piso — config de dinero, dos writes secuenciales no deben dejar una mezcla inconsistente.
  async function saveRow() {
    if (dirty) {
      const ok = await onSavePricing({
        id: offering.id,
        enabled: offering.enabled,
        mode,
        multiplier: multNum,
        minFareCents,
        baseFareCents,
        perKmCents,
        perMinCents,
      });
      if (!ok) return;
    }
    if (allowsPuja && floorDirty) {
      await onSaveFloor(offering.id, floorDraftCents);
    }
  }

  const Icon = offeringIcon(offering);
  const toggleTitle = `${offering.enabled ? 'Deshabilitar' : 'Habilitar'} ${offeringLabel(offering.id)}`;
  const toggleDescription = offering.enabled
    ? `Los pasajeros dejarán de ver y cotizar ${offeringLabel(offering.id)}. Esta acción cambia el catálogo global y queda auditada.`
    : `Los pasajeros volverán a ver y cotizar ${offeringLabel(offering.id)}. Esta acción cambia el catálogo global y queda auditada.`;

  return (
    <>
      <tr className={cn('bg-surface', crossWarn ? '' : 'border-b border-border')}>
        {/* Categoría: chevron (abre la tarifa a medida) + ícono en cuadrito + nombre legible + chip "a medida". */}
        <td className="py-2.5 pl-3 pr-3 align-middle">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={detailOpen}
              aria-label={`${detailOpen ? 'Ocultar' : 'Mostrar'} la tarifa a medida de ${offeringLabel(offering.id)}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {detailOpen ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
            </button>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-ink-muted">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-ink">{offeringLabel(offering.id)}</span>
              {hasParamOverride ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-brand">
                  Tarifa a medida
                </span>
              ) : null}
            </div>
          </div>
        </td>

        {/* Modo (ADR 023): las verticales especiales van LOCKED ("la ambulancia NO negocia") → label read-only con
            candado. El resto elige el modo EXPLÍCITO Fijo↔Puja (sin "por defecto" ambiguo: el select muestra el modo
            vigente y, al elegir, lo fija). COST_SHARE es booking-service (Fase B), no va en on-demand. */}
        <td className="px-3 py-2.5 align-middle">
          {offering.modeLocked ? (
            <span
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted"
              title="Fijo por la vertical del servicio"
            >
              <Lock className="size-3.5 text-ink-subtle" aria-hidden />
              {MODE_LABEL[offering.mode]}
            </span>
          ) : (
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as PricingMode)}
              disabled={!canManage}
              aria-label={`Modo de ${offeringLabel(offering.id)}`}
              className="h-9 w-28 rounded-md border border-border-strong bg-surface-2 px-2 text-sm text-ink outline-none focus:border-brand disabled:opacity-50"
            >
              <option value={PricingMode.FIXED}>{MODE_LABEL[PricingMode.FIXED]}</option>
              <option value={PricingMode.PUJA}>{MODE_LABEL[PricingMode.PUJA]}</option>
            </select>
          )}
        </td>

        {/* Multiplicador. */}
        <td className="px-3 py-2.5 align-middle">
          <RateCell unit="×" error={multInvalid ? 'Debe ser > 0' : undefined}>
            <RateInput
              type="number"
              inputMode="decimal"
              step="0.05"
              min="0"
              max={MULTIPLIER_MAX_UI}
              placeholder={offering.pricing.multiplier.toString()}
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
              disabled={!canManage}
              aria-label={`Multiplicador de ${offeringLabel(offering.id)}`}
            />
          </RateCell>
        </td>

        {/* Tarifa mínima FIJA. */}
        <td className="px-3 py-2.5 align-middle">
          <RateCell unit="S/" error={minFareInvalid ? 'Debe ser ≥ 0' : undefined}>
            <RateInput
              type="number"
              inputMode="decimal"
              step="0.50"
              min="0"
              placeholder={formatSolesInput(offering.pricing.minFareCents)}
              value={minFareSoles}
              onChange={(e) => setMinFareSoles(e.target.value)}
              disabled={!canManage}
              aria-label={`Tarifa mínima de ${offeringLabel(offering.id)}`}
            />
          </RateCell>
        </td>

        {/* Piso de la PUJA: solo para las que pujan; FIXED-only → "— solo fijo". Degradación honesta si el
            bid-floor (config aparte) no cargó: "No disponible" + Reintentar, sin tumbar el resto de la fila. */}
        <td className="px-3 py-2.5 align-middle">
          {allowsPuja ? (
            floor !== undefined ? (
              <RateCell
                unit="S/"
                error={floorInvalid ? `Entre 1 y ${BID_FLOOR_MAX_SOLES}` : undefined}
              >
                <RateInput
                  type="number"
                  inputMode="decimal"
                  step="0.50"
                  min="1"
                  max={BID_FLOOR_MAX_SOLES}
                  placeholder={formatSolesInput(floor.defaultFloorCents)}
                  value={floorSoles}
                  onChange={(e) => setFloorSoles(e.target.value)}
                  disabled={!canManageFloor}
                  aria-label={`Piso de puja de ${offeringLabel(offering.id)}`}
                />
              </RateCell>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-subtle">No disponible</span>
                <Button variant="ghost" size="sm" onClick={onRetryFloor}>
                  <RefreshCw className="size-3.5" aria-hidden /> Reintentar
                </Button>
              </div>
            )
          ) : (
            <span className="text-sm text-ink-subtle" title="El piso solo aplica en modo Puja">
              —
            </span>
          )}
        </td>

        {/* Activa: switch. Editable (canManage y no en vuelo) → dispara setEnabled tras step-up; si no, indicador. */}
        <td className="px-3 py-2.5 align-middle">
          {canManage && !pending ? (
            <StepUpDialog
              title={toggleTitle}
              description={toggleDescription}
              onVerified={() => onSetEnabled(offering.id, !offering.enabled)}
              trigger={
                <Switch
                  checked={offering.enabled}
                  label={`${offering.enabled ? 'Deshabilitar' : 'Habilitar'} ${offeringLabel(offering.id)}`}
                />
              }
            />
          ) : (
            <Switch
              checked={offering.enabled}
              disabled
              label={`${offeringLabel(offering.id)} ${offering.enabled ? 'habilitada' : 'deshabilitada'}`}
            />
          )}
        </td>

        {/* Guardar (icon-button): mismo gate + step-up que SaveAction; solo se muestra con permiso de catálogo. */}
        <td className="py-2.5 pl-3 pr-5 align-middle">
          <div className="flex justify-end">
            <SaveAction
              canManage={canManage}
              dirty={dirty || (allowsPuja && floorDirty)}
              invalid={
                multInvalid ||
                minFareInvalid ||
                baseFareInvalid ||
                perKmInvalid ||
                perMinInvalid ||
                (allowsPuja && floorInvalid)
              }
              saving={pending || pendingFloor}
              onSave={saveRow}
              title={`Guardar ${offeringLabel(offering.id)}`}
              description="Esta acción cambia la config de pricing de la oferta (catálogo y/o piso de puja) y queda auditada."
              icon={<Check className="size-4" aria-hidden />}
            />
          </div>
        </td>
      </tr>

      {/* Tarifa a medida (ADR 023 §3 · progressive disclosure): los params POR-SERVICIO (banderazo/km/min) viven
          en una fila de detalle expandible — la mayoría de las ofertas hereda el global, así que la tabla queda
          limpia y solo se abre cuando el operador quiere anular la fórmula para ESTE servicio. Placeholder en gris
          = el valor GLOBAL real (vacío lo usa). `0` válido (Mecánico plano perKm/perMin=0; Grúa sin per-min). */}
      {detailOpen ? (
        <tr className="border-b border-border bg-surface-2/40">
          <td colSpan={7} className="px-5 pb-4 pt-1">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <p className="w-full text-[11px] text-ink-subtle">
                Tarifa a medida de{' '}
                <span className="font-medium text-ink-muted">{offeringLabel(offering.id)}</span> —
                anulá la fórmula global solo para este servicio. Cada campo vacío usa el global (el
                número en gris).
              </p>
              <div>
                <p className="mb-1 text-[11px] font-medium text-ink-subtle">Banderazo</p>
                <RateCell unit="S/" error={baseFareInvalid ? `0–${MAX_BASE_FARE_SOLES}` : undefined}>
                  <RateInput
                    type="number"
                    inputMode="decimal"
                    step="0.10"
                    min="0"
                    max={MAX_BASE_FARE_SOLES}
                    placeholder={globalPlaceholder(baseFare?.baseFareCents)}
                    value={baseFareSoles}
                    onChange={(e) => setBaseFareSoles(e.target.value)}
                    disabled={!canManage}
                    aria-label={`Banderazo de ${offeringLabel(offering.id)} (vacío = usa el global)`}
                  />
                </RateCell>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-ink-subtle">Por km</p>
                <RateCell unit="S/·km" error={perKmInvalid ? `0–${MAX_PER_KM_SOLES}` : undefined}>
                  <RateInput
                    type="number"
                    inputMode="decimal"
                    step="0.10"
                    min="0"
                    max={MAX_PER_KM_SOLES}
                    placeholder={globalPlaceholder(baseFare?.perKmCents)}
                    value={perKmSoles}
                    onChange={(e) => setPerKmSoles(e.target.value)}
                    disabled={!canManage}
                    aria-label={`Precio por km de ${offeringLabel(offering.id)} (vacío = usa el global)`}
                  />
                </RateCell>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-ink-subtle">Por min</p>
                <RateCell unit="S/·min" error={perMinInvalid ? `0–${MAX_PER_MIN_SOLES}` : undefined}>
                  <RateInput
                    type="number"
                    inputMode="decimal"
                    step="0.10"
                    min="0"
                    max={MAX_PER_MIN_SOLES}
                    placeholder={globalPlaceholder(baseFare?.perMinCents)}
                    value={perMinSoles}
                    onChange={(e) => setPerMinSoles(e.target.value)}
                    disabled={!canManage}
                    aria-label={`Precio por min de ${offeringLabel(offering.id)} (vacío = usa el global)`}
                  />
                </RateCell>
              </div>
            </div>
          </td>
        </tr>
      ) : null}

      {/* Validación cruzada (A1): fila de aviso DEBAJO de la afectada, visible también en solo-lectura (es una
          incongruencia del DATO). */}
      {crossWarn ? (
        <tr className="border-b border-border bg-surface">
          <td colSpan={7} className="px-5 pb-3">
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Piso de puja (S/{formatSolesInput(crossWarn.floorCents)}) &gt; tarifa mínima fija
                (S/
                {formatSolesInput(crossWarn.fixedMinCents)}) — la puja no debería costar más que el
                fijo.
              </span>
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
