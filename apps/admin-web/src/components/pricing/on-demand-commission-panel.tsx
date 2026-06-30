'use client';

import { useState } from 'react';
import { Percent } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';

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
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Percent className="size-4" aria-hidden /> Comisión al conductor (on-demand)
      </h3>
      <p className="mt-1 max-w-2xl text-sm text-ink-subtle">
        La comisión se <strong>descuenta al conductor</strong>: el pasajero paga la tarifa del viaje y el
        conductor recibe la tarifa menos esta comisión.
      </p>

      <div className="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field
          label="Comisión al conductor (%)"
          hint={`Actual: ${bpsToPercentLabel(config.onDemandRateBps)}%`}
          error={invalid ? `Entre 0 y ${MAX_RATE_PCT}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            max={MAX_RATE_PCT}
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar comisión on-demand"
          description="Esta acción cambia la comisión global que se descuenta al conductor en los viajes on-demand y queda auditada."
        />
      </div>

      <ReadOnlyNote canManage={canManage} noun="la comisión" className="mt-3" />
    </section>
  );
}
