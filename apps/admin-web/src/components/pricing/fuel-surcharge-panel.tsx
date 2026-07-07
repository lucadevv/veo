'use client';

import { useState } from 'react';
import type { FuelSurchargeView } from '@/lib/api/schemas';
import { useReplaceFuelSurcharge } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';

/** Techos de cordura (espejo del DTO server-side, defensa en profundidad UI). */
const MAX_SOLES_PER_LITER = 100;
const MAX_KM_PER_LITER = 200;

/**
 * Recargo de combustible (B4). El admin ingresa lo que VE en el grifo — el PRECIO por litro — y el
 * RENDIMIENTO del vehículo de referencia (km/litro). El sistema DERIVA el recargo por km = precio ÷
 * rendimiento, lo suma a la tarifa por km (FIXED + sugerido de PUJA) y lo escala por oferta. Server-driven:
 * el quote/create del pasajero lo reflejan al instante. La UI solo refleja `pricing:manage`; el admin-bff +
 * trip-service re-autorizan. Precio en SOLES/litro (se persiste en céntimos); rendimiento en km/litro entero.
 *
 * DOS modelos, UNO activo: el recargo de combustible (B4) y el modelo de energía (B5) son mutuamente
 * excluyentes (el flip lo decide la config del sistema, NO este panel). El tag de la card refleja cuál rige
 * hoy: "activo" cuando el recargo está en efecto, "inactivo" cuando fue reemplazado por el modelo de energía
 * (lo que se edita queda guardado pero sin efecto hasta que el flip revierta).
 */
export function FuelSurchargePanel({ config }: { config: FuelSurchargeView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const replace = useReplaceFuelSurcharge();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el combustible',
    error: 'No se pudo guardar el combustible',
    success: (p) => {
      const derived = p.kmPerLiter > 0 ? Math.round(p.fuelPricePerLiterCents / p.kmPerLiter) : 0;
      return `Combustible: S/${formatSolesInput(p.fuelPricePerLiterCents)}/L ÷ ${p.kmPerLiter} km/L → recargo S/${formatSolesInput(derived)}/km`;
    },
  });

  const [priceSoles, setPriceSoles] = useState<string>(
    formatSolesInput(config.fuelPricePerLiterCents),
  );
  const [kmPerLiter, setKmPerLiter] = useState<string>(String(config.kmPerLiter));

  const priceCents = parseSolesInput(priceSoles);
  const km = kmPerLiter.trim() === '' ? 0 : Math.round(Number(kmPerLiter));
  const priceInvalid =
    !Number.isFinite(priceCents) || priceCents < 0 || priceCents > MAX_SOLES_PER_LITER * 100;
  const kmInvalid = !Number.isFinite(km) || km < 0 || km > MAX_KM_PER_LITER;
  const invalid = priceInvalid || kmInvalid;

  // El recargo/km DERIVADO (preview en vivo, misma fórmula que el server: precio ÷ rendimiento).
  const derivedPerKmCents = km > 0 ? Math.round(priceCents / km) : 0;
  const dirty = priceCents !== config.fuelPricePerLiterCents || km !== config.kmPerLiter;

  // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409 y
  // useConfigSave muestra el toast de conflicto (el onSettled de la mutation re-sincroniza los valores vigentes).
  const onSave = () =>
    save({ fuelPricePerLiterCents: priceCents, kmPerLiter: km, expectedVersion: config.version });

  return (
    <ConfigCard
      title="Recargo por combustible / energía"
      tag={config.active ? 'activo' : 'inactivo'}
      tagTone={config.active ? 'success' : 'neutral'}
      description={
        config.active
          ? 'Ingresá el precio del combustible (lo que ves en el grifo) y el rendimiento del vehículo de referencia. El sistema deriva el recargo por km = precio ÷ rendimiento y lo aplica a la tarifa (precio fijo y sugerido de puja). El cambio es global, inmediato y queda auditado.'
          : 'Reemplazado por el modelo de precios de energía: lo que edites acá NO afecta la tarifa mientras el modelo de energía esté activo. El cambio de modelo lo decide la configuración del sistema, no este panel.'
      }
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar cambio de recargo de combustible"
          description="Esta acción cambia el pricing global y queda auditada."
        />
      }
    >
      <RateField
        label="Precio del combustible"
        sub={`Actual: S/${formatSolesInput(config.fuelPricePerLiterCents)}`}
        unit="S/·L"
        error={priceInvalid ? `Entre 0 y ${MAX_SOLES_PER_LITER}` : undefined}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.10"
          min="0"
          max={MAX_SOLES_PER_LITER}
          value={priceSoles}
          onChange={(e) => setPriceSoles(e.target.value)}
          disabled={!canManage}
        />
      </RateField>

      <RateField
        label="Rendimiento"
        sub="Vehículo de referencia; 0 = sin recargo"
        unit="km/L"
        error={kmInvalid ? `Entre 0 y ${MAX_KM_PER_LITER}` : undefined}
      >
        <RateInput
          type="number"
          inputMode="numeric"
          step="1"
          min="0"
          max={MAX_KM_PER_LITER}
          value={kmPerLiter}
          onChange={(e) => setKmPerLiter(e.target.value)}
          disabled={!canManage}
        />
      </RateField>

      {/* Preview del recargo derivado. El valor PERSISTIDO se etiqueta según el estado: "vigente" SOLO si el
          recargo está activo; si fue reemplazado, "guardado · sin efecto" (no mentir que está en efecto). */}
      <p className="text-sm text-ink">
        Recargo derivado:{' '}
        <span className="font-medium text-accent">
          S/{formatSolesInput(derivedPerKmCents)} por km
        </span>{' '}
        <span className="text-ink-subtle">
          {config.active
            ? `(vigente: S/${formatSolesInput(config.perKmCents)}/km)`
            : `(guardado: S/${formatSolesInput(config.perKmCents)}/km · sin efecto hoy)`}
        </span>
      </p>

      <ReadOnlyNote canManage={canManage} noun="el combustible" />
    </ConfigCard>
  );
}
