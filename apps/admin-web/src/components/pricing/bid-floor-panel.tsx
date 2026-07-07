'use client';

import { useState } from 'react';
import type { BidFloorView } from '@/lib/api/schemas';
import { useReplaceBidFloor } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { bidFloorDefaultReplace } from '@/lib/bid-floor';
import { useConfigSave } from '@/lib/use-config-save';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';

/** Techo de cordura (espejo del DTO server-side BID_FLOOR_MAX_CENTS, defensa en profundidad UI). S/1000. */
const MAX_SOLES = 1000;

/**
 * Piso por DEFECTO de la PUJA (ADR 010 §9.3). Este panel edita SOLO el piso global por defecto: el mínimo que un
 * pasajero puede ofertar en modo PUJA cuando la oferta no tiene un piso propio. Los pisos POR SERVICIO (ej. moto
 * más bajo que confort) se editan en "Ofertas de servicio" (A1) — acá se PRESERVAN intactos (el `PUT` es
 * wholesale, así que se remandan tal cual con `bidFloorDefaultReplace`). trip-service aplica el piso como gate
 * AUTORITATIVO en createTrip/rebid y el quote lo MUESTRA por oferta (el MISMO resolver). Per-zona queda
 * zone-ready (hoy zona única GLOBAL). Server-driven: la UI solo refleja `pricing:manage`; admin-bff +
 * trip-service re-autorizan (step-up MFA).
 */
export function BidFloorPanel({ config }: { config: BidFloorView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const replace = useReplaceBidFloor();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el piso',
    error: 'No se pudo guardar el piso',
    success: (p) => `Piso por defecto guardado: S/${formatSolesInput(p.defaultFloorCents)}`,
  });

  // Piso por defecto (soles). Los overrides por servicio NO se editan acá — viven en "Ofertas de servicio".
  const [defaultSoles, setDefaultSoles] = useState<string>(formatSolesInput(config.defaultFloorCents));

  const defaultCents = parseSolesInput(defaultSoles);
  const invalid =
    !Number.isFinite(defaultCents) || defaultCents < 1 || defaultCents > MAX_SOLES * 100;

  // dirty = ¿cambió el default respecto de lo persistido? Sin esto el Guardar quedaba habilitado SIN cambios
  // (save no-op con step-up + auditoría). Solo compara el default: los overrides no se tocan en este panel.
  const dirty = defaultCents !== config.defaultFloorCents;

  // El PUT es wholesale: se remandan los overrides por oferta TAL CUAL (config.overrides) para no borrarlos.
  // expectedVersion = la que cargamos (CAS): si otro admin la movió, el server responde 409 y useConfigSave
  // muestra el toast de conflicto (el onSettled de la mutation re-sincroniza los valores vigentes).
  const onSave = () => save(bidFloorDefaultReplace(config, defaultCents));

  return (
    <ConfigCard
      title="Piso de puja"
      tag="default global"
      description="La oferta MÍNIMA que un pasajero puede proponer en el carril PUJA, por defecto. El piso por servicio (ej. moto más bajo) se configura por fila en Ofertas de servicio."
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar cambio del piso de la puja"
          description="Esta acción cambia el pricing (piso mínimo de oferta) y queda auditada."
        />
      }
    >
      <RateField
        label="Piso por defecto"
        sub={`Actual: S/${formatSolesInput(config.defaultFloorCents)}`}
        unit="S/"
        error={invalid ? `Entre 1 y ${MAX_SOLES}` : undefined}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.50"
          min="1"
          max={MAX_SOLES}
          value={defaultSoles}
          onChange={(e) => setDefaultSoles(e.target.value)}
          disabled={!canManage}
        />
      </RateField>
      <ReadOnlyNote canManage={canManage} noun="el piso de la puja" />
    </ConfigCard>
  );
}
