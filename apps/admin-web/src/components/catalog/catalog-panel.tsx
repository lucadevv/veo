'use client';

import { useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { solesToCents } from '@veo/utils/money';
import { PricingMode } from '@veo/shared-types';
import type {
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
import { formatSolesInput, parseSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';

/** Valor del select "Automático" (sin pin → manda el schedule global). */
const AUTO = '';

/** Etiqueta legible del modo de pricing para el panel (display, no comparación de dominio). */
const MODE_LABEL: Record<PricingMode, string> = { PUJA: 'Puja', FIXED: 'Precio fijo' };

// Espejo del MULTIPLIER_MAX autoritativo (trip-service catalog.dto). El contrato/UI no importan shared-types;
// el valor vive acá como literal documentado. trip-service y el admin-bff RE-validan server-side.
const MULTIPLIER_MAX_UI = 10;

/**
 * Tarifas por oferta (ADR 013 · Fase B / A1). El admin prende/apaga cada oferta y, por oferta, pinea el MODO
 * (PUJA/FIXED, restringido a lo que la oferta permite), ajusta el PRECIO (multiplicador + tarifa mínima FIJA)
 * y —para las ofertas que pujan— el PISO de la PUJA. A1 unifica acá los DOS mínimos que antes vivían partidos
 * (tarifa fija en Catálogo, piso de puja en Precios) con validación cruzada visible. El pasajero ve/cotiza/crea
 * SOLO con lo configurado (server-driven); admin-bff + trip-service re-autorizan y re-validan server-side.
 *
 * El catálogo y el piso de la PUJA son DOS configs distintas (endpoint + versión/CAS propios): cada una tiene
 * su Guardar, su step-up y su optimistic-locking. No se mezclan en un PUT — serían dos mutations no-atómicas.
 */
export function CatalogPanel({ catalog, bidFloor }: { catalog: CatalogView; bidFloor: BidFloorView }) {
  const user = useSession();
  const canManage = can(user, 'catalog:manage');
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
    save({ overrides: withOverride(catalog.overrides, next), expectedVersion: catalog.version }, msg);

  async function setEnabled(id: string, enabled: boolean) {
    const ov = overrideOf(id); // preserva modo/precio al togglear
    await commit(
      { id, enabled, mode: ov?.mode, multiplier: ov?.multiplier, minFareCents: ov?.minFareCents },
      `${offeringLabel(id)} ${enabled ? 'habilitada' : 'deshabilitada'}`,
    );
  }

  async function savePricing(next: CatalogOverride) {
    await commit(next, `${offeringLabel(next.id)}: precio y modo actualizados`);
  }

  // FULL-REPLACE del overlay del bid-floor con SOLO esta oferta tocada (cents) o quitada (null → usa el default).
  // expectedVersion = la del bidFloor (su propio CAS, distinto del catálogo).
  async function saveFloor(offeringId: string, cents: number | null) {
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

  return (
    <div className="flex flex-col gap-6 pt-4">
      <section>
        <h2 className="text-sm font-medium text-ink-muted">Ofertas de servicio</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          El pasajero ve, cotiza y pide solo con lo configurado acá. El modo se restringe a lo que
          cada oferta permite; el precio sale de la fórmula (distancia/tiempo) y estos valores lo
          escalan. Cada oferta lleva dos mínimos: la tarifa fija y, si puja, el piso de la puja. El
          cambio es global y queda auditado.
        </p>

        {activeCount === 0 ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            Ninguna oferta habilitada: los pasajeros no podrán pedir un viaje hasta que actives al
            menos una.
          </p>
        ) : null}

        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {catalog.offerings.map((o) => (
            <OfferingRow
              key={o.id}
              offering={o}
              override={overrideOf(o.id)}
              floorOverrideCents={offeringFloorOverrideCents(bidFloor, o.id)}
              defaultFloorCents={bidFloor.defaultFloorCents}
              canManage={canManage}
              pending={saving}
              pendingFloor={savingBid}
              onSetEnabled={setEnabled}
              onSavePricing={savePricing}
              onSaveFloor={saveFloor}
            />
          ))}
        </ul>

        <ReadOnlyNote canManage={canManage} noun="el catálogo" className="mt-3" />
      </section>
    </div>
  );
}

/** Una fila de oferta: estado + (si canManage) editor de modo + precio + piso de puja, cada uno con su guardado dirty. */
function OfferingRow({
  offering,
  override,
  floorOverrideCents,
  defaultFloorCents,
  canManage,
  pending,
  pendingFloor,
  onSetEnabled,
  onSavePricing,
  onSaveFloor,
}: {
  offering: CatalogOffering;
  override: CatalogOverride | undefined;
  floorOverrideCents: number | null;
  defaultFloorCents: number;
  canManage: boolean;
  pending: boolean;
  pendingFloor: boolean;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onSavePricing: (next: CatalogOverride) => Promise<void>;
  onSaveFloor: (id: string, cents: number | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<string>(override?.mode ?? AUTO);
  const [multiplier, setMultiplier] = useState<string>(override?.multiplier?.toString() ?? '');
  const [minFareSoles, setMinFareSoles] = useState<string>(
    override?.minFareCents != null ? formatSolesInput(override.minFareCents) : '',
  );
  // Piso de la PUJA: '' = sin override (usa el default), igual que en el panel de Precios.
  const [floorSoles, setFloorSoles] = useState<string>(
    floorOverrideCents != null ? formatSolesInput(floorOverrideCents) : '',
  );

  // ¿Esta oferta puja? Las FIXED-only (ambulancia/grúa/mecánico) NO llevan piso de puja.
  const allowsPuja = offering.allowedModes.includes(PricingMode.PUJA);

  // Parseo: vacío → undefined (usar el de código). Inválido → bloquea el guardado.
  const multNum = multiplier.trim() === '' ? undefined : Number(multiplier);
  const minFareCents =
    minFareSoles.trim() === '' ? undefined : solesToCents(Number(minFareSoles));
  // Tope de cordura del multiplicador: corta el dedazo ×100 ANTES de mandar (el BFF y trip-service re-validan
  // server-side con MULTIPLIER_MAX=10 autoritativo). 0 < x ≤ 10.
  const multInvalid =
    multNum !== undefined &&
    (!Number.isFinite(multNum) || multNum <= 0 || multNum > MULTIPLIER_MAX_UI);
  const minFareInvalid =
    minFareCents !== undefined && (!Number.isFinite(minFareCents) || minFareCents < 0);

  // Piso de puja: '' = null (sin override). Bounds 1..MAX (espejo del server, igual que el panel de Precios).
  const floorDraftCents = floorSoles.trim() === '' ? null : parseSolesInput(floorSoles);
  const floorInvalid =
    floorDraftCents !== null &&
    (!Number.isFinite(floorDraftCents) ||
      floorDraftCents < 1 ||
      floorDraftCents > BID_FLOOR_MAX_SOLES * 100);
  const floorDirty = floorDraftCents !== floorOverrideCents;

  const dirty =
    (mode || AUTO) !== (override?.mode ?? AUTO) ||
    (multNum ?? null) !== (override?.multiplier ?? null) ||
    (minFareCents ?? null) !== (override?.minFareCents ?? null);

  // Validación cruzada: comparo los mínimos EFECTIVOS (draft válido si lo hay, si no el persistido). El piso
  // efectivo = override ?? default; la tarifa fija efectiva = draft ?? la del catálogo (`pricing` ya es efectivo).
  const effFloorCents =
    floorDraftCents !== null && !floorInvalid
      ? floorDraftCents
      : (floorOverrideCents ?? defaultFloorCents);
  const effFixedMinCents =
    minFareCents !== undefined && !minFareInvalid ? minFareCents : offering.pricing.minFareCents;
  const showCrossWarn = allowsPuja && pujaFloorExceedsFixedMin(effFloorCents, effFixedMinCents);

  // UN solo Guardar por fila: salva lo que cambió de CADA config (catálogo y/o piso de puja). Son dos endpoints
  // con su propio CAS, pero el operador no debería ver dos botones — un step-up cubre la acción y cada save
  // mantiene su 409/toast por separado (fallo parcial honesto: si el catálogo guarda y el piso da 409, se ve).
  async function saveRow() {
    if (dirty) {
      await onSavePricing({
        id: offering.id,
        enabled: offering.enabled,
        mode: (mode as PricingMode) || undefined,
        multiplier: multNum,
        minFareCents,
      });
    }
    if (allowsPuja && floorDirty) {
      await onSaveFloor(offering.id, floorDraftCents);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="font-medium text-ink">{offeringLabel(offering.id)}</span>
          <span className="text-xs text-ink-subtle">
            {offering.vehicleClass} · efectivo ×{offering.pricing.multiplier} · mín S/
            {formatSolesInput(offering.pricing.minFareCents)}
            {offering.modePin ? ` · modo ${MODE_LABEL[offering.modePin]}` : ' · modo automático'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {offering.enabled ? (
            <Badge tone="success" className="gap-1">
              <Check className="size-3.5" aria-hidden /> Habilitada
            </Badge>
          ) : (
            <Badge tone="neutral" className="gap-1">
              <X className="size-3.5" aria-hidden /> Deshabilitada
            </Badge>
          )}

          {canManage ? (
            pending ? (
              <Button variant={offering.enabled ? 'ghost' : 'primary'} size="sm" disabled>
                {offering.enabled ? 'Deshabilitar' : 'Habilitar'}
              </Button>
            ) : (
              <StepUpDialog
                trigger={
                  <Button variant={offering.enabled ? 'ghost' : 'primary'} size="sm">
                    {offering.enabled ? 'Deshabilitar' : 'Habilitar'}
                  </Button>
                }
                title={`${offering.enabled ? 'Deshabilitar' : 'Habilitar'} ${offeringLabel(offering.id)}`}
                description={
                  offering.enabled
                    ? `Los pasajeros dejarán de ver y cotizar ${offeringLabel(offering.id)}. Esta acción cambia el catálogo global y queda auditada.`
                    : `Los pasajeros volverán a ver y cotizar ${offeringLabel(offering.id)}. Esta acción cambia el catálogo global y queda auditada.`
                }
                onVerified={() => onSetEnabled(offering.id, !offering.enabled)}
              />
            )
          ) : null}
        </div>
      </div>

      {/* Validación cruzada (A1): visible también en solo-lectura, porque es una incongruencia del DATO. */}
      {showCrossWarn ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            El piso de puja (S/{formatSolesInput(effFloorCents)}) supera la tarifa mínima fija (S/
            {formatSolesInput(effFixedMinCents)}): el mismo viaje sale más barato en FIJO que el
            mínimo que se puede pujar.
          </span>
        </p>
      ) : null}

      {canManage ? (
        // UN grid con todos los knobs per-oferta + UN Guardar. Las ofertas que pujan suman la 4ta columna
        // "Piso de puja" ADYACENTE a "Tarifa mínima" → los dos mínimos se leen juntos, sin hueco ni 2do botón.
        <div
          className={`grid grid-cols-1 items-end gap-3 ${
            allowsPuja ? 'sm:grid-cols-[1fr_1fr_1fr_1fr_auto]' : 'sm:grid-cols-[1fr_1fr_1fr_auto]'
          }`}
        >
          <Field label="Modo" hint="Restringido a lo que la oferta permite">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink hover:border-border-strong focus-visible:outline-none"
            >
              <option value={AUTO}>Automático (según horario)</option>
              {offering.allowedModes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Multiplicador"
            hint="Vacío = valor de código"
            error={multInvalid ? 'Debe ser > 0' : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.05"
              min="0"
              max={MULTIPLIER_MAX_UI}
              placeholder={offering.pricing.multiplier.toString()}
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
            />
          </Field>

          <Field
            label="Tarifa mínima (S/)"
            hint="Mínimo en modo FIJO · vacío = valor de código"
            error={minFareInvalid ? 'Debe ser ≥ 0' : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.50"
              min="0"
              placeholder={formatSolesInput(offering.pricing.minFareCents)}
              value={minFareSoles}
              onChange={(e) => setMinFareSoles(e.target.value)}
            />
          </Field>

          {allowsPuja ? (
            <Field
              label="Piso de puja (S/)"
              hint="Mínimo en modo PUJA · vacío = usa el default"
              error={floorInvalid ? `Entre 1 y ${BID_FLOOR_MAX_SOLES}` : undefined}
            >
              <Input
                type="number"
                inputMode="decimal"
                step="0.50"
                min="1"
                max={BID_FLOOR_MAX_SOLES}
                placeholder={`default S/${formatSolesInput(defaultFloorCents)}`}
                value={floorSoles}
                onChange={(e) => setFloorSoles(e.target.value)}
              />
            </Field>
          ) : null}

          <SaveAction
            canManage={canManage}
            dirty={dirty || (allowsPuja && floorDirty)}
            invalid={multInvalid || minFareInvalid || (allowsPuja && floorInvalid)}
            saving={pending || pendingFloor}
            onSave={saveRow}
            title={`Guardar ${offeringLabel(offering.id)}`}
            description="Esta acción cambia la config de pricing de la oferta (catálogo y/o piso de puja) y queda auditada."
            size="sm"
          />
        </div>
      ) : null}
    </li>
  );
}
