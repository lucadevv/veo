'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { solesToCents } from '@veo/utils/money';
import type { CatalogOffering, CatalogOverride, CatalogView, PricingMode } from '@/lib/api/schemas';
import { offeringLabel, withOverride } from '@/lib/catalog';
import { useReplaceCatalog } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { StepUpDialog } from '@/components/security/step-up-dialog';
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
 * Panel del catálogo de ofertas (ADR 013 · Fase B). El admin prende/apaga cada oferta y, por oferta,
 * pinea el MODO (PUJA/FIXED, restringido a lo que la oferta permite — la UI refleja el invariante) y
 * ajusta el PRECIO (multiplicador + tarifa mínima; la tarifa sale de la fórmula, esto la escala/pisa).
 * El pasajero ve/cotiza/crea SOLO con lo configurado (server-driven). Cambios wholesale que PRESERVAN
 * el resto del overlay; el admin-bff + trip-service re-autorizan y re-validan server-side (la UI no autoriza).
 */
export function CatalogPanel({ catalog }: { catalog: CatalogView }) {
  const user = useSession();
  const canManage = can(user, 'catalog:manage');
  const replace = useReplaceCatalog();
  // El mensaje de éxito varía por acción (habilitar/deshabilitar vs precio/modo) → se pasa por-llamada como
  // override de `save`. El copy de conflicto/error es canónico (parametrizado por el sustantivo "el catálogo").
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el catálogo',
    error: 'No se pudo guardar el catálogo',
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

  const activeCount = catalog.offerings.filter((o) => o.enabled).length;

  return (
    <div className="flex flex-col gap-6 pt-4">
      <section>
        <h2 className="text-sm font-medium text-ink-muted">Ofertas de servicio</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          El pasajero ve, cotiza y pide solo con lo configurado acá. El modo se restringe a lo que
          cada oferta permite; el precio sale de la fórmula (distancia/tiempo) y estos valores lo
          escalan. El cambio es global y queda auditado.
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
              canManage={canManage}
              pending={saving}
              onSetEnabled={setEnabled}
              onSavePricing={savePricing}
            />
          ))}
        </ul>

        {!canManage ? (
          <p className="mt-3 text-xs text-ink-subtle">
            Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar el catálogo.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** Una fila del catálogo: estado + (si canManage) editor de modo + precio con draft local y guardado dirty. */
function OfferingRow({
  offering,
  override,
  canManage,
  pending,
  onSetEnabled,
  onSavePricing,
}: {
  offering: CatalogOffering;
  override: CatalogOverride | undefined;
  canManage: boolean;
  pending: boolean;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onSavePricing: (next: CatalogOverride) => Promise<void>;
}) {
  const [mode, setMode] = useState<string>(override?.mode ?? AUTO);
  const [multiplier, setMultiplier] = useState<string>(override?.multiplier?.toString() ?? '');
  const [minFareSoles, setMinFareSoles] = useState<string>(
    override?.minFareCents != null ? formatSolesInput(override.minFareCents) : '',
  );

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

  const dirty =
    (mode || AUTO) !== (override?.mode ?? AUTO) ||
    (multNum ?? null) !== (override?.multiplier ?? null) ||
    (minFareCents ?? null) !== (override?.minFareCents ?? null);

  function save() {
    void onSavePricing({
      id: offering.id,
      enabled: offering.enabled,
      mode: (mode as PricingMode) || undefined,
      multiplier: multNum,
      minFareCents,
    });
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

      {canManage ? (
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
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
            hint="Vacío = valor de código"
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

          {!dirty || multInvalid || minFareInvalid || pending ? (
            <Button variant="primary" size="sm" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title={`Guardar precio de ${offeringLabel(offering.id)}`}
              description="Esta acción cambia el catálogo global y queda auditada."
              trigger={
                <Button variant="primary" size="sm">
                  Guardar
                </Button>
              }
              onVerified={save}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}
