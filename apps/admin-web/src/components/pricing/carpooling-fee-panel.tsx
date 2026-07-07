'use client';

import { useState } from 'react';
import type { CommissionView } from '@/lib/api/schemas';
import { useReplaceCommission } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useConfigSave } from '@/lib/use-config-save';
import {
  MAX_RATE_PCT,
  BPS_PER_PERCENT,
  bpsToPercentLabel,
  commissionReplace,
  percentToBps,
} from '@/lib/commission';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';

/**
 * Service fee del CARPOOLING (carril cost-sharing · F2.7 · ADR-015 §11.2) — card del diseño (veo.pen). El admin
 * edita SOLO el fee que se SUMA al pasajero — el conductor cobra el 100% de su contribución, así que no hay nudo
 * legal (es un cargo al pasajero, no lucro sobre el conductor). La comisión ON-DEMAND vive en Precios on-demand:
 * comparten un mismo config con UNA versión, por eso el save de acá PRESERVA `onDemandRateBps` vía
 * `commissionReplace` (perderlo sería borrar dinero). Full-replace con CAS: 409 si otro admin movió la versión.
 * La UI solo refleja `finance:manage`; admin-bff + payment-service re-autorizan.
 */
export function CarpoolingFeePanel({ config }: { config: CommissionView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const replace = useReplaceCommission();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el service fee del carpooling',
    error: 'No se pudo guardar el service fee del carpooling',
    success: (p) => `Service fee del carpooling actualizado · ${bpsToPercentLabel(p.carpoolingFeeBps)}%`,
  });

  const [pct, setPct] = useState<string>(bpsToPercentLabel(config.carpoolingFeeBps));

  const bps = percentToBps(pct);
  const invalid = !Number.isFinite(bps) || bps < 0 || bps > MAX_RATE_PCT * BPS_PER_PERCENT;
  const dirty = bps !== config.carpoolingFeeBps;

  // commissionReplace PRESERVA onDemandRateBps tal cual está persistido; expectedVersion = el CAS cargado.
  const onSave = () => save(commissionReplace(config, { carpoolingFeeBps: bps }));

  return (
    <ConfigCard
      title="Service fee al pasajero"
      tag="cost-sharing"
      tagTone="brand"
      description="El service fee se suma al pasajero sobre el costo compartido. El conductor cobra el 100% de su contribución, así que no hay lucro sobre el conductor."
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar service fee del carpooling"
          description="Esta acción cambia el service fee global que se suma al pasajero en el carpooling y queda auditada."
        />
      }
    >
      <RateField
        label="Service fee"
        sub={`Actual: ${bpsToPercentLabel(config.carpoolingFeeBps)}%`}
        unit="%"
        error={invalid ? `Entre 0 y ${MAX_RATE_PCT}` : undefined}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
          max={MAX_RATE_PCT}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          disabled={!canManage}
        />
      </RateField>
      <ReadOnlyNote canManage={canManage} noun="el service fee" />
    </ConfigCard>
  );
}
