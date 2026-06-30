'use client';

import { useState } from 'react';
import { Percent } from 'lucide-react';
import type { CommissionView } from '@/lib/api/schemas';
import { useReplaceCommission } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useConfigSave } from '@/lib/use-config-save';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';

/** Tope de cordura (espejo del DTO server-side, defensa en profundidad UI). La comisión no puede pasar de 100%. */
const MAX_RATE_PCT = 100;
/** 100% = 10000 basis points. La tasa se PERSISTE en bps Int (nunca float); el panel la muestra en %. */
const BPS_PER_PERCENT = 100;

/** Convierte un input en % a basis points Int (tasa SIEMPRE Int, nunca float persistido). Vacío = 0. */
function percentToBps(pct: string): number {
  return pct.trim() === '' ? 0 : Math.round(Number(pct) * BPS_PER_PERCENT);
}

/** bps Int → % para mostrar (2000 bps → "20.00"). */
function bpsToPercentLabel(bps: number): string {
  return (bps / BPS_PER_PERCENT).toFixed(2);
}

/**
 * Comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). El admin edita DOS tasas, con modelos distintos:
 *  - On-demand: la comisión que se DESCUENTA al conductor (el pasajero paga la tarifa; el conductor recibe
 *    tarifa − comisión).
 *  - Carpooling: un service fee que se SUMA al pasajero (cost-sharing) — el conductor cobra el 100% de su
 *    contribución. No tiene nudo legal: es un cargo al pasajero, no lucro sobre el conductor.
 * Full-replace con CAS: se mandan ambas tasas con la `version` cargada (409 si otro admin la movió). La UI solo
 * refleja `finance:manage`; el admin-bff + payment-service re-autorizan y auditan. Tasas en basis points Int.
 */
export function CommissionPanel({ config }: { config: CommissionView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const replace = useReplaceCommission();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'la comisión',
    error: 'No se pudo guardar la comisión',
    success: (p) =>
      `Comisión actualizada · on-demand ${bpsToPercentLabel(p.onDemandRateBps)}% · carpooling ${bpsToPercentLabel(p.carpoolingFeeBps)}%`,
  });

  const [onDemandPct, setOnDemandPct] = useState<string>(bpsToPercentLabel(config.onDemandRateBps));
  const [carpoolingPct, setCarpoolingPct] = useState<string>(
    bpsToPercentLabel(config.carpoolingFeeBps),
  );

  const onDemandBps = percentToBps(onDemandPct);
  const carpoolingBps = percentToBps(carpoolingPct);
  const rangeBps = (bps: number) =>
    !Number.isFinite(bps) || bps < 0 || bps > MAX_RATE_PCT * BPS_PER_PERCENT;
  const onDemandInvalid = rangeBps(onDemandBps);
  const carpoolingInvalid = rangeBps(carpoolingBps);
  const invalid = onDemandInvalid || carpoolingInvalid;
  const dirty =
    onDemandBps !== config.onDemandRateBps || carpoolingBps !== config.carpoolingFeeBps;

  // Full-replace: se mandan AMBAS tasas. expectedVersion = la que cargamos (optimistic locking): si otro admin
  // la movió, el server responde 409 y useConfigSave muestra el toast de conflicto (el onSettled re-sincroniza).
  const onSave = () =>
    save({
      onDemandRateBps: onDemandBps,
      carpoolingFeeBps: carpoolingBps,
      expectedVersion: config.version,
    });

  return (
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Percent className="size-4" aria-hidden /> Comisión por modo
      </h3>
      <p className="mt-1 text-sm text-ink-subtle">
        Dos modelos distintos. <strong>On-demand</strong>: la comisión se <strong>descuenta al conductor</strong>{' '}
        (el pasajero paga la tarifa, el conductor recibe la tarifa menos la comisión). <strong>Carpooling</strong>:
        el <strong>service fee se suma al pasajero</strong>, el conductor cobra el 100% de su contribución.
      </p>

      <div className="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field
          label="On-demand · comisión al conductor (%)"
          hint={`Actual: ${bpsToPercentLabel(config.onDemandRateBps)}%`}
          error={onDemandInvalid ? `Entre 0 y ${MAX_RATE_PCT}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            max={MAX_RATE_PCT}
            value={onDemandPct}
            onChange={(e) => setOnDemandPct(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <Field
          label="Carpooling · service fee al pasajero (%)"
          hint={`Actual: ${bpsToPercentLabel(config.carpoolingFeeBps)}%`}
          error={carpoolingInvalid ? `Entre 0 y ${MAX_RATE_PCT}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            max={MAX_RATE_PCT}
            value={carpoolingPct}
            onChange={(e) => setCarpoolingPct(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar cambio de comisión"
          description="Esta acción cambia las comisiones globales (on-demand y carpooling) y queda auditada."
        />
      </div>

      <ReadOnlyNote canManage={canManage} noun="la comisión" className="mt-3" />
    </section>
  );
}
