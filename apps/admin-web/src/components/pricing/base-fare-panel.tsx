'use client';

import { useState } from 'react';
import { Banknote } from 'lucide-react';
import type { BaseFareView } from '@/lib/api/schemas';
import { useReplaceBaseFare } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';

/** Techos de cordura (espejo del DTO server-side, defensa en profundidad UI). En SOLES. */
const MAX_BASE_FARE_SOLES = 200;
const MAX_PER_KM_SOLES = 50;
const MAX_PER_MIN_SOLES = 20;

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
  const replace = useReplaceBaseFare();
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'la tarifa base',
    error: 'No se pudo guardar la tarifa base',
    success: (p) =>
      `Tarifa base: S/${formatSolesInput(p.baseFareCents)} + S/${formatSolesInput(p.perKmCents)}/km + S/${formatSolesInput(p.perMinCents)}/min`,
  });

  const [baseSoles, setBaseSoles] = useState<string>(formatSolesInput(config.baseFareCents));
  const [perKmSoles, setPerKmSoles] = useState<string>(formatSolesInput(config.perKmCents));
  const [perMinSoles, setPerMinSoles] = useState<string>(formatSolesInput(config.perMinCents));

  const baseCents = parseSolesInput(baseSoles);
  const perKmCents = parseSolesInput(perKmSoles);
  const perMinCents = parseSolesInput(perMinSoles);

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

  // expectedVersion = la que cargamos (optimistic locking): si otro admin la movió, el server responde 409 y
  // useConfigSave muestra el toast de conflicto. El onSettled de la mutation (queries.ts) re-sincroniza.
  const onSave = () =>
    save({ baseFareCents: baseCents, perKmCents, perMinCents, expectedVersion: config.version });

  return (
    <section className="pt-6">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <Banknote className="size-4" aria-hidden /> Tarifa base
      </h3>
      <p className="mt-1 text-sm text-ink-subtle">
        Los tres componentes base de la fórmula de tarifa (precio fijo y sugerido de puja).
      </p>

      <div className="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field
          label="Banderazo (S/)"
          hint={`Actual: S/${formatSolesInput(config.baseFareCents)}`}
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
          hint={`Actual: S/${formatSolesInput(config.perKmCents)}`}
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
          hint={`Actual: S/${formatSolesInput(config.perMinCents)}`}
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

        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar cambio de tarifa base"
          description="Esta acción cambia el pricing global y queda auditada."
        />
      </div>

      <ReadOnlyNote canManage={canManage} noun="la tarifa base" className="mt-3" />
    </section>
  );
}
