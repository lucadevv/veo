'use client';

import { useState } from 'react';
import { Percent } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { CommissionView } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useReplaceCommission } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';

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
 * Comisión por modo (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). El admin edita la tasa de comisión ON-DEMAND (la
 * que la plataforma retiene de cada cobro on-demand). La comisión del CARPOOLING es 0% FIJO y SOLO-LECTURA:
 * cobrar comisión sobre un viaje compartido (cost-sharing) sería lucro de la plataforma → ilegal hasta el
 * visto bueno legal; subirla requiere un ADR + flag, no un cambio del admin. La UI solo refleja `finance:manage`;
 * el admin-bff + payment-service re-autorizan y auditan. La tasa se persiste en basis points Int (nunca float).
 */
export function CommissionPanel({ config }: { config: CommissionView }) {
  const user = useSession();
  const canManage = can(user, 'finance:manage');
  const { toast } = useToast();
  const replace = useReplaceCommission();

  const [pct, setPct] = useState<string>(bpsToPercentLabel(config.onDemandRateBps));

  const bps = percentToBps(pct);
  const invalid = !Number.isFinite(bps) || bps < 0 || bps > MAX_RATE_PCT * BPS_PER_PERCENT;
  const dirty = bps !== config.onDemandRateBps;

  async function save() {
    try {
      // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409.
      await replace.mutateAsync({ onDemandRateBps: bps, expectedVersion: config.version });
      toast({ tone: 'success', title: `Comisión on-demand: ${bpsToPercentLabel(bps)}%` });
    } catch (err) {
      // 409 = otro admin cambió el config mientras editabas. El hook ya re-sincroniza (onSettled) → el panel
      // muestra los valores vigentes; pedimos revisar y reintentar (NO se pisó nada: degradación honesta).
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'La comisión la cambió otro admin. Recargamos el valor vigente — revisá y reintentá.'
          : `No se pudo guardar la comisión${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <section className="pt-6">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Percent className="size-4" aria-hidden /> Comisión por modo
      </h2>
      <p className="mt-1 text-sm text-ink-subtle">
        La tasa que la plataforma retiene de cada cobro. La comisión <strong>on-demand</strong> es
        configurable; la del <strong>carpooling</strong> es 0% fijo (cost-sharing: por validación legal). El
        cambio es global, inmediato y queda auditado.
      </p>

      <div className="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field
          label="On-demand (%)"
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

        <Field label="Carpooling (%)" hint="0% — gated por validación legal (ADR-015 §11.2)">
          <Input type="number" value={(config.carpoolingRateBps / BPS_PER_PERCENT).toFixed(2)} disabled readOnly />
        </Field>

        {canManage ? (
          !dirty || invalid || replace.isPending ? (
            <Button variant="primary" size="md" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title="Confirmar cambio de comisión"
              description="Esta acción cambia la comisión on-demand global y queda auditada."
              trigger={
                <Button variant="primary" size="md">
                  Guardar
                </Button>
              }
              onVerified={save}
            />
          )
        ) : null}
      </div>

      <p className="mt-3 text-xs text-ink-subtle">
        El carpooling es 0% hasta el visto bueno legal (ADR-015 §11.2): cobrar comisión sobre un viaje
        compartido sería lucro de la plataforma. Subirla requiere un ADR + flag, no un cambio acá.
      </p>

      {!canManage ? (
        <p className="mt-3 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar la comisión.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-ink-subtle">
        Versión {config.version}
        {config.updatedAt ? ` · actualizado ${dateTime(config.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </section>
  );
}
