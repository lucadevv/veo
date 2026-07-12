'use client';

import { useState } from 'react';
import type { CommissionView } from '@/lib/api/schemas';
import { useReplaceOnDemandRate } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useConfigSave } from '@/lib/use-config-save';
import { MAX_RATE_PCT, BPS_PER_PERCENT, bpsToPercentLabel, percentToBps } from '@/lib/commission';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';
import { PriceDiffHint } from '@/components/config/price-diff-hint';

/** Formato del hint LIVE-DIFF (tasa): bps → "20.00%" (mismo `bpsToPercentLabel` que el sub "Actual"). */
const pctLabel = (bps: number) => `${bpsToPercentLabel(bps)}%`;

/**
 * Comisión ON-DEMAND (carril taxi · F2.7 · ADR-017 §1.6 · CAS desacoplada #3). El admin edita SOLO la tasa que se
 * DESCUENTA al conductor (el pasajero paga la tarifa; el conductor recibe tarifa − comisión). El service fee del
 * CARPOOLING vive en su propia pantalla con su PROPIA version (`carpoolingFeeVersion`), así que este save manda
 * SOLO `onDemandRateBps` + `expectedVersion = config.version` a su propio endpoint: editar acá ya NO 409ea el panel
 * de carpooling. CAS: 409 solo si otro admin movió la version de ON-DEMAND. La UI solo refleja `finance:manage`;
 * admin-bff + payment-service re-autorizan.
 */
export function OnDemandCommissionPanel({ config }: { config: CommissionView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const replace = useReplaceOnDemandRate();
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

  // Solo la tasa on-demand + su CAS (`config.version`): el endpoint de on-demand NO toca el carpooling.
  const onSave = () => save({ onDemandRateBps: bps, expectedVersion: config.version });

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
        hint={<PriceDiffHint before={config.onDemandRateBps} after={bps} format={pctLabel} />}
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
