'use client';

import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import type { BaseFareView } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useReplaceBaseFare } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Techos de cordura (espejo del DTO server-side, defensa en profundidad UI). En SOLES. */
const MAX_BASE_FARE_SOLES = 200;
const MAX_PER_KM_SOLES = 50;
const MAX_PER_MIN_SOLES = 20;

/** Convierte un input en soles a céntimos Int (dinero SIEMPRE Int, nunca float). Vacío = 0. */
function solesToCents(soles: string): number {
  return soles.trim() === '' ? 0 : Math.round(Number(soles) * 100);
}

/**
 * Tarifa base (F2.4). El admin edita los tres componentes base de la fórmula de tarifa — banderazo (tarifa
 * fija de arranque), costo por kilómetro y costo por minuto — que antes estaban hardcodeados. El cambio es
 * global, inmediato (server-driven: el quote/create del pasajero lo reflejan al instante) y queda auditado.
 * La UI solo refleja `pricing:manage`; el admin-bff + trip-service re-autorizan. Valores en SOLES (se
 * persisten en céntimos Int).
 */
export function BaseFarePanel({ config }: { config: BaseFareView }) {
  const user = useSession();
  const canManage = can(user, 'pricing:manage');
  const { toast } = useToast();
  const replace = useReplaceBaseFare();

  const [baseSoles, setBaseSoles] = useState<string>((config.baseFareCents / 100).toFixed(2));
  const [perKmSoles, setPerKmSoles] = useState<string>((config.perKmCents / 100).toFixed(2));
  const [perMinSoles, setPerMinSoles] = useState<string>((config.perMinCents / 100).toFixed(2));

  const baseCents = solesToCents(baseSoles);
  const perKmCents = solesToCents(perKmSoles);
  const perMinCents = solesToCents(perMinSoles);

  const baseInvalid =
    !Number.isFinite(baseCents) || baseCents < 0 || baseCents > MAX_BASE_FARE_SOLES * 100;
  const perKmInvalid =
    !Number.isFinite(perKmCents) || perKmCents < 0 || perKmCents > MAX_PER_KM_SOLES * 100;
  const perMinInvalid =
    !Number.isFinite(perMinCents) || perMinCents < 0 || perMinCents > MAX_PER_MIN_SOLES * 100;
  const invalid = baseInvalid || perKmInvalid || perMinInvalid;

  const dirty =
    baseCents !== config.baseFareCents ||
    perKmCents !== config.perKmCents ||
    perMinCents !== config.perMinCents;

  async function save() {
    try {
      // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409.
      await replace.mutateAsync({
        baseFareCents: baseCents,
        perKmCents,
        perMinCents,
        expectedVersion: config.version,
      });
      toast({
        tone: 'success',
        title: `Tarifa base: S/${(baseCents / 100).toFixed(2)} + S/${(perKmCents / 100).toFixed(2)}/km + S/${(perMinCents / 100).toFixed(2)}/min`,
      });
    } catch (err) {
      // 409 = otro admin cambió el config mientras editabas. El hook ya re-sincroniza (onSettled) → el panel
      // muestra los valores vigentes; pedimos revisar y reintentar (NO se pisó nada: degradación honesta).
      const conflict = err instanceof ApiError && err.status === 409;
      toast({
        tone: conflict ? 'info' : 'danger',
        title: conflict
          ? 'La tarifa base la cambió otro admin. Recargamos los valores vigentes — revisá y reintentá.'
          : `No se pudo guardar la tarifa base${err instanceof Error ? `: ${err.message}` : ''}`,
      });
    }
  }

  return (
    <section className="pt-6">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Banknote className="size-4" aria-hidden /> Tarifa base
      </h2>
      <p className="mt-1 text-sm text-ink-subtle">
        El banderazo (tarifa fija de arranque), el costo por kilómetro y el costo por minuto. Son los
        componentes base de la fórmula de tarifa (precio fijo y sugerido de puja). El cambio es global,
        inmediato y queda auditado.
      </p>

      <div className="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field
          label="Banderazo (S/)"
          hint={`Actual: S/${(config.baseFareCents / 100).toFixed(2)}`}
          error={baseInvalid ? `Entre 0 y ${MAX_BASE_FARE_SOLES}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.10"
            min="0"
            max={MAX_BASE_FARE_SOLES}
            value={baseSoles}
            onChange={(e) => setBaseSoles(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <Field
          label="Por kilómetro (S/)"
          hint={`Actual: S/${(config.perKmCents / 100).toFixed(2)}`}
          error={perKmInvalid ? `Entre 0 y ${MAX_PER_KM_SOLES}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.10"
            min="0"
            max={MAX_PER_KM_SOLES}
            value={perKmSoles}
            onChange={(e) => setPerKmSoles(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        <Field
          label="Por minuto (S/)"
          hint={`Actual: S/${(config.perMinCents / 100).toFixed(2)}`}
          error={perMinInvalid ? `Entre 0 y ${MAX_PER_MIN_SOLES}` : undefined}
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.10"
            min="0"
            max={MAX_PER_MIN_SOLES}
            value={perMinSoles}
            onChange={(e) => setPerMinSoles(e.target.value)}
            disabled={!canManage}
          />
        </Field>

        {canManage ? (
          !dirty || invalid || replace.isPending ? (
            <Button variant="primary" size="md" disabled>
              Guardar
            </Button>
          ) : (
            <StepUpDialog
              title="Confirmar cambio de tarifa base"
              description="Esta acción cambia el pricing global y queda auditada."
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

      {!canManage ? (
        <p className="mt-3 text-xs text-ink-subtle">
          Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar la tarifa base.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-ink-subtle">
        Versión {config.version}
        {config.updatedAt ? ` · actualizado ${dateTime(config.updatedAt)}` : ' · sin cambios aún'}
      </p>
    </section>
  );
}
