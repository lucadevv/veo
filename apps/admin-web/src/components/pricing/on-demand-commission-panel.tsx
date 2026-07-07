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
 * Comisión ON-DEMAND (carril taxi · F2.7 · ADR-017 §1.6). El admin edita SOLO la tasa que se DESCUENTA al
 * conductor (el pasajero paga la tarifa; el conductor recibe tarifa − comisión). El service fee del CARPOOLING
 * vive en su propia pantalla (Carpooling): aunque comparten un mismo config con UNA versión, el save de acá
 * PRESERVA `carpoolingFeeBps` vía `commissionReplace` (perderlo sería borrar dinero). Full-replace con CAS: 409
 * si otro admin movió la versión. La UI solo refleja `finance:manage`; admin-bff + payment-service re-autorizan.
 */
export function OnDemandCommissionPanel({ config }: { config: CommissionView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const replace = useReplaceCommission();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'la comisión on-demand',
    error: 'No se pudo guardar la comisión on-demand',
    success: (p) => `Comisión on-demand actualizada · ${bpsToPercentLabel(p.onDemandRateBps)}%`,
  });

  const [pct, setPct] = useState<string>(bpsToPercentLabel(config.onDemandRateBps));

  const bps = percentToBps(pct);
  const invalid = !Number.isFinite(bps) || bps < 0 || bps > MAX_RATE_PCT * BPS_PER_PERCENT;
  const dirty = bps !== config.onDemandRateBps;

  // commissionReplace PRESERVA carpoolingFeeBps tal cual está persistido; expectedVersion = el CAS cargado.
  const onSave = () => save(commissionReplace(config, { onDemandRateBps: bps }));

  return (
    <ConfigCard
      title="Comisión ON-DEMAND"
      tag="descuento al conductor"
      tagTone="brand"
      description="La comisión se descuenta al conductor: el pasajero paga la tarifa del viaje y el conductor recibe la tarifa menos esta comisión."
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar comisión on-demand"
          description="Esta acción cambia la comisión global que se descuenta al conductor en los viajes on-demand y queda auditada."
        />
      }
    >
      <RateField
        label="Tasa on-demand"
        sub={`Actual: ${bpsToPercentLabel(config.onDemandRateBps)}% · ${config.onDemandRateBps} bps`}
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
      <ReadOnlyNote canManage={canManage} noun="la comisión" />
    </ConfigCard>
  );
}
