'use client';

import { useState } from 'react';
import type { BaseFareView } from '@/lib/api/schemas';
import { useReplaceBaseFare } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';
import { PriceDiffHint } from '@/components/config/price-diff-hint';

/** Formato del hint LIVE-DIFF (money): céntimos → "S/1.35" (mismo `formatSolesInput` que el sub "Actual"). */
const moneyLabel = (cents: number) => `S/${formatSolesInput(cents)}`;

/** Techos de cordura (espejo del DTO server-side, defensa en profundidad UI). En SOLES. */
const MAX_BASE_FARE_SOLES = 200;
const MAX_PER_KM_SOLES = 50;
const MAX_PER_MIN_SOLES = 20;

/**
 * Tarifa base (F2.4) — card del diseño (veo.pen): banderazo + por km + por minuto, cada componente editable,
 * guardado por sección detrás de step-up MFA (SaveAction). El cambio es global, inmediato y auditado. La UI
 * solo refleja `pricing:manage`; el admin-bff + trip-service re-autorizan. Valores en SOLES (persistidos en Int).
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

  const onSave = () =>
    save({ baseFareCents: baseCents, perKmCents, perMinCents, expectedVersion: config.version });

  return (
    <ConfigCard
      title="Tarifa base"
      tag="componentes"
      description="Banderazo + por-km + por-minuto. El por-km es all-in (incluye combustible)."
      footer={
        <SaveAction
          canManage={canManage}
          dirty={dirty}
          invalid={invalid}
          saving={saving}
          onSave={onSave}
          title="Confirmar cambio de tarifa base"
          description="Esta acción cambia el pricing global y queda auditada."
        />
      }
    >
      <RateField
        label="Banderazo"
        sub={`Actual: S/${formatSolesInput(config.baseFareCents)}`}
        unit="S/"
        error={baseInvalid ? `Entre 0 y ${MAX_BASE_FARE_SOLES}` : undefined}
        hint={<PriceDiffHint before={config.baseFareCents} after={baseCents} format={moneyLabel} />}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.10"
          min="0"
          max={MAX_BASE_FARE_SOLES}
          value={baseSoles}
          onChange={(e) => setBaseSoles(e.target.value)}
          disabled={!canManage}
        />
      </RateField>
      <RateField
        label="Por kilómetro"
        sub={`Actual: S/${formatSolesInput(config.perKmCents)}`}
        unit="S/·km"
        error={perKmInvalid ? `Entre 0 y ${MAX_PER_KM_SOLES}` : undefined}
        hint={<PriceDiffHint before={config.perKmCents} after={perKmCents} format={moneyLabel} />}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.10"
          min="0"
          max={MAX_PER_KM_SOLES}
          value={perKmSoles}
          onChange={(e) => setPerKmSoles(e.target.value)}
          disabled={!canManage}
        />
      </RateField>
      <RateField
        label="Por minuto"
        sub={`Actual: S/${formatSolesInput(config.perMinCents)}`}
        unit="S/·min"
        error={perMinInvalid ? `Entre 0 y ${MAX_PER_MIN_SOLES}` : undefined}
        hint={<PriceDiffHint before={config.perMinCents} after={perMinCents} format={moneyLabel} />}
      >
        <RateInput
          type="number"
          inputMode="decimal"
          step="0.10"
          min="0"
          max={MAX_PER_MIN_SOLES}
          value={perMinSoles}
          onChange={(e) => setPerMinSoles(e.target.value)}
          disabled={!canManage}
        />
      </RateField>
      <ReadOnlyNote canManage={canManage} noun="la tarifa base" />
    </ConfigCard>
  );
}
